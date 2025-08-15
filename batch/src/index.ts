import ical from 'ical-generator';
import { parseHTML } from 'linkedom';
import ICAL from 'ical.js';

interface FaBEvent {
	title: string;
	eventType: string;
	startDatetime: Date;
	location: string;
	format: string;
	details: string;
}

interface Env {
	BUCKET: R2Bucket;
	ENV?: string;
}

const ORDINAL_REGEX = /(\d{1,2})(st|nd|rd|th)/gi;
const JST_OFFSET = 9 * 60; // JST is UTC+9

// External iCal feed URLs
const EXTERNAL_ICAL_FEEDS = [
	'https://calendar.google.com/calendar/ical/fable.fabtcg%40gmail.com/public/basic.ics',
	'https://calendar.google.com/calendar/ical/tokyofab.info%40gmail.com/public/basic.ics'
];

export default {
	async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log('Scheduled event triggered at', controller.cron);
		try {
			// Get events from FaB official site
			const officialEvents = await scrapeEventFinder();
			console.log(`Found ${officialEvents.length} official events`);
			
			// Get events from external iCal feeds
			const externalEvents = await fetchExternalEvents(env);
			console.log(`Found ${externalEvents.length} external events`);
			
			// Remove duplicates and combine events
			const uniqueEvents = removeDuplicateEvents(officialEvents, externalEvents);
			console.log(`Total ${uniqueEvents.length} events (after deduplication)`);
			
			const icalContent = generateIcal(uniqueEvents);
			
			await env.BUCKET.put('calendar.ics', icalContent, {
				httpMetadata: {
					contentType: 'text/calendar; charset=utf-8'
				}
			});
			
			console.log('Successfully saved calendar.ics to R2 bucket');
		} catch (error) {
			console.error('Error in scheduled task:', error);
		}
	},
} satisfies ExportedHandler<Env>;

function generateIcal(events: FaBEvent[]): string {
	const calendar = ical({ 
		name: 'Kanto FaB Events',
		timezone: 'Asia/Tokyo'
	});
	
	for (const event of events) {
		// Let ical-generator handle timezone conversion automatically
		calendar.createEvent({
			start: event.startDatetime,
			timezone: 'Asia/Tokyo',
			summary: `【${event.format}】${event.title}`,
			location: event.location,
			description: event.details
		});
	}
	
	return calendar.toString();
}

async function scrapeEventFinder(): Promise<FaBEvent[]> {
	const url = 'https://fabtcg.com/ja/events/';
	const params = new URLSearchParams({
		format: '',
		type: '',
		distance: '50',
		query: '日本、東京都品川区上大崎２丁目１６ 目黒駅',
		sort: 'date',
		mode: 'event',
		page: '1'
	});

	// First request to get total page count
	const firstPageResponse = await fetch(`${url}?${params}`);
	if (!firstPageResponse.ok) {
		throw new Error(`HTTP error! status: ${firstPageResponse.status}`);
	}

	const firstPageHtml = await firstPageResponse.text();
	const { document: firstPageDoc } = parseHTML(firstPageHtml);
	
	const paginationLinks = firstPageDoc.querySelectorAll('body > article > div > div.container.paginator > div > div > div.pagination-arrow.pagination-arrow-next.text-right > li > a');
	let totalPageCount = 1;
	
	if (paginationLinks.length > 0) {
		const href = paginationLinks[0].getAttribute('href');
		if (href) {
			const urlParams = new URLSearchParams(href.split('?')[1]);
			const pageParam = urlParams.get('page');
			if (pageParam) {
				totalPageCount = parseInt(pageParam, 10);
			}
		}
	}
	
	const events: FaBEvent[] = [];
	
	for (let pageNumber = 1; pageNumber <= totalPageCount; pageNumber++) {
		params.set('page', pageNumber.toString());
		
		const pageResponse = await fetch(`${url}?${params}`);
		if (!pageResponse.ok) {
			continue;
		}
		
		const pageHtml = await pageResponse.text();
		const { document } = parseHTML(pageHtml);
		
		const eventDetails = document.querySelectorAll('body > article > div > div.event');
		
		for (const eventDetail of eventDetails) {
			try {
				const insideDiv = eventDetail.querySelector('div.text-lg-left');
				if (!insideDiv) continue;
				
				const h2 = insideDiv.querySelector('h2');
				if (!h2) continue;
				
				const title = h2.textContent?.trim() || '';
				const titleDatas = title.split('\n').map((s: string) => s.trim()).filter((s: string) => s);
				
				if (titleDatas.length < 3) continue;
				
				const pElements = eventDetail.querySelectorAll('p');
				if (pElements.length < 2) continue;
				
				const datetimeFormatP = pElements[0];
				const locateP = pElements[1];
				
				const year = new Date().getFullYear();
				const datetimeText = datetimeFormatP.textContent?.trim() || '';
				const startDatetimeCleaned = datetimeText
					.replace(ORDINAL_REGEX, '$1')
					.split('\n')[0]
					.trim()
					.replace(',', `, ${year},`);
				
				let startDatetime: Date;
				try {
					startDatetime = parseDateTime(startDatetimeCleaned);
				} catch {
					continue;
				}
				
				// The scraped time is in JST - keep it as-is for generateIcal to handle consistently
				
				const formatText = datetimeText.split('\n')[2]?.trim() || '';
				
				events.push({
					title: `${titleDatas[1]}@${titleDatas[2]}`,
					eventType: titleDatas[1],
					startDatetime,
					location: locateP.textContent?.trim() || '',
					format: formatText,
					details: ''
				});
			} catch (error) {
				continue;
			}
		}
	}
	
	return events;
}

function parseDateTime(dateTimeStr: string): Date {
	// First try pattern with minutes: "Sun 3 Aug, 2025, 1:30 PM"
	let match = dateTimeStr.match(/^(\w{3})\s+(\d{1,2})\s+(\w{3}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i);
	if (match) {
		const [, , day, monthName, year, hour, minute, ampm] = match;
		return createDate(day, monthName, year, hour, minute, ampm);
	}
	
	// Then try pattern without minutes: "Sun 3 Aug, 2025, 1 PM"
	match = dateTimeStr.match(/^(\w{3})\s+(\d{1,2})\s+(\w{3}),\s+(\d{4}),\s+(\d{1,2})\s+(AM|PM)$/i);
	if (match) {
		const [, , day, monthName, year, hour, ampm] = match;
		return createDate(day, monthName, year, hour, '0', ampm);
	}
	
	throw new Error(`Unable to parse datetime: ${dateTimeStr}`);
}

function createDate(day: string, monthName: string, year: string, hour: string, minute: string, ampm: string): Date {
	const monthMap: { [key: string]: number } = {
		jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
		jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
	};
	
	const monthIndex = monthMap[monthName.toLowerCase()];
	if (monthIndex === undefined) {
		throw new Error(`Unknown month: ${monthName}`);
	}
	
	let hour24 = parseInt(hour, 10);
	if (ampm.toUpperCase() === 'PM' && hour24 !== 12) {
		hour24 += 12;
	} else if (ampm.toUpperCase() === 'AM' && hour24 === 12) {
		hour24 = 0;
	}
	
	// Create local JST date (not UTC) to avoid timezone conversion by ical-generator
	return new Date(parseInt(year, 10), monthIndex, parseInt(day, 10), hour24, parseInt(minute, 10));
}

async function fetchExternalEvents(env?: Env): Promise<FaBEvent[]> {
	const allExternalEvents: FaBEvent[] = [];
	
	for (const feedUrl of EXTERNAL_ICAL_FEEDS) {
		try {
			console.log(`Fetching iCal feed: ${feedUrl}`);
			const response = await fetch(feedUrl);
			
			if (!response.ok) {
				console.error(`Failed to fetch ${feedUrl}: ${response.status}`);
				continue;
			}
			
			const icalText = await response.text();
			const events = parseICalEvents(icalText, feedUrl, env);
			console.log(`Parsed ${events.length} events from ${feedUrl}`);
			
			allExternalEvents.push(...events);
		} catch (error) {
			console.error(`Error fetching ${feedUrl}:`, error);
		}
	}
	
	return allExternalEvents;
}

function parseICalEvents(icalText: string, source: string, env?: Env): FaBEvent[] {
	const events: FaBEvent[] = [];
	const isCloudflare = (env?.ENV || 'local') === 'cloudflare';
	
	try {
		const jcalData = ICAL.parse(icalText);
		const comp = new ICAL.Component(jcalData);
		const vevents = comp.getAllSubcomponents('vevent');
		
		console.log(`Found ${vevents.length} VEVENT components in ${source}`);
		
		for (const vevent of vevents) {
			try {
				const event = new ICAL.Event(vevent);
				
				// Extract event details
				const summary = event.summary || '';
				const location = event.location || '';
				const description = event.description || '';
				const startDate = event.startDate?.toJSDate();
				
				// 除外するキーワードをチェック
				const excludeKeywords = ['grand archive', '定休日'];
				const shouldExclude = excludeKeywords.some(keyword => 
					summary.toLowerCase().includes(keyword) || 
					description.toLowerCase().includes(keyword)
				);
				
				if (shouldExclude) {
					continue; // このイベントをスキップ
				}
				
				if (startDate && summary) {
					// Handle recurring events by expanding them
					if (event.isRecurring()) {
						const now = new Date();
						const sixMonthsLater = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
						
						try {
							// Expand recurring events within the next 6 months
							const expandedEvents = event.component.jCal;
							const recurExpander = new ICAL.RecurExpansion({
								component: event.component,
								dtstart: event.startDate
							});
							
							let count = 0;
							let next;
							while ((next = recurExpander.next()) && count < 50 && next.toJSDate() <= sixMonthsLater) {
								let occurrenceDate = next.toJSDate();
								
								// Cloudflare環境では9時間後に変換
								if (isCloudflare) {
									occurrenceDate = new Date(occurrenceDate.getTime() + (JST_OFFSET * 60000));
								}
								
								if (occurrenceDate >= now) {
									// Determine source name from URL
									let sourceName = 'External';
									if (source.includes('fable.fabtcg')) {
										sourceName = 'Fable';
									} else if (source.includes('tokyofab.info')) {
										sourceName = 'Tokyo FAB';
									}
									
									events.push({
										title: `${summary}@${sourceName}`,
										eventType: 'External Event',
										startDatetime: occurrenceDate,
										location: location,
										format: 'External',
										details: description
									});
								}
								count++;
							}
						} catch (recurError) {
							console.warn('Error expanding recurring event:', recurError);
							// Fallback to single event
							// Determine source name from URL
							let sourceName = 'External';
							if (source.includes('fable.fabtcg')) {
								sourceName = 'Fable';
							} else if (source.includes('tokyofab.info')) {
								sourceName = 'Tokyo FAB';
							}
							
							// Cloudflare環境では9時間後に変換
							const adjustedStartDate = isCloudflare && startDate 
								? new Date(startDate.getTime() + (JST_OFFSET * 60000))
								: startDate;
								
							events.push({
								title: `${summary}@${sourceName}`,
								eventType: 'External Event',
								startDatetime: adjustedStartDate || new Date(),
								location: location,
								format: 'External',
								details: description
							});
						}
					} else {
						// Single event
						// Determine source name from URL
						let sourceName = 'External';
						if (source.includes('fable.fabtcg')) {
							sourceName = 'Fable';
						} else if (source.includes('tokyofab.info')) {
							sourceName = 'Tokyo FAB';
						}
						
						// Cloudflare環境では9時間後に変換
						const adjustedStartDate = isCloudflare && startDate 
							? new Date(startDate.getTime() + (JST_OFFSET * 60000))
							: startDate;
							
						events.push({
							title: `${summary}@${sourceName}`,
							eventType: 'External Event',
							startDatetime: adjustedStartDate || new Date(),
							location: location,
							format: 'External',
							details: description
						});
					}
				}
			} catch (error) {
				console.warn('Error parsing individual event:', error);
			}
		}
	} catch (error) {
		console.error('Error parsing iCal data:', error);
	}
	
	return events;
}

function removeDuplicateEvents(officialEvents: FaBEvent[], externalEvents: FaBEvent[]): FaBEvent[] {
	// Filter events to reasonable time range (past 1 month to future 6 months)
	const now = new Date();
	const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
	const sixMonthsLater = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
	
	const recentExternalEvents = externalEvents.filter(e => 
		e.startDatetime >= oneMonthAgo && e.startDatetime <= sixMonthsLater
	);
	
	console.log(`Filtered external events: ${externalEvents.length} -> ${recentExternalEvents.length} (within time range)`);
	
	const uniqueEvents = [...recentExternalEvents]; // 外部イベントを優先
	const duplicateCount = { removed: 0, kept: 0 };
	
	for (const officialEvent of officialEvents) {
		const matchingExternal = recentExternalEvents.find(externalEvent => 
			isDuplicateEvent(officialEvent, externalEvent)
		);
		
		if (matchingExternal) {
			duplicateCount.removed++;
			console.log(`Duplicate removed: ${officialEvent.title} matches ${matchingExternal.title}`);
		} else {
			uniqueEvents.push(officialEvent);
			duplicateCount.kept++;
		}
	}
	
	console.log(`Deduplication: ${duplicateCount.removed} duplicates removed, ${duplicateCount.kept} official events kept`);
	return uniqueEvents;
}

function isDuplicateEvent(event1: FaBEvent, event2: FaBEvent): boolean {
	// Skip non-game events
	const nonGameKeywords = ['定休日', '休み', '休業', 'closed'];
	const isNonGameEvent = (event: FaBEvent) => 
		nonGameKeywords.some(keyword => 
			event.title.toLowerCase().includes(keyword) ||
			event.format.toLowerCase().includes(keyword)
		);
	
	if (isNonGameEvent(event1) || isNonGameEvent(event2)) {
		return false;
	}
	
	// 時刻の比較（30分以内の差を許容）
	const timeDiff = Math.abs(event1.startDatetime.getTime() - event2.startDatetime.getTime());
	const timeThreshold = 30 * 60 * 1000; // 30分
	
	if (timeDiff > timeThreshold) {
		return false;
	}
	
	// 場所の比較（同じ店舗かどうか）
	const location1 = event1.location.toLowerCase();
	const location2 = event2.location.toLowerCase();
	
	const isSameVenue = (
		(location1.includes('fable') && location2.includes('fable')) ||
		(location1.includes('tokyo fab') && location2.includes('tokyo fab')) ||
		(location1.includes('cardon') && location2.includes('cardon')) ||
		(location1.includes('amenity dream') && location2.includes('amenity dream'))
	);
	
	if (!isSameVenue) {
		return false;
	}
	
	// タイトル・形式の類似度チェック
	const title1 = event1.title.toLowerCase();
	const title2 = event2.title.toLowerCase();
	const format1 = event1.format.toLowerCase();
	const format2 = event2.format.toLowerCase();
	
	// 共通キーワードをチェック
	const commonKeywords = ['learn to play', 'armory', 'blitz', 'classic constructed', 'pro quest', 'draft'];
	const hasCommonKeyword = commonKeywords.some(keyword => 
		(title1.includes(keyword) || format1.includes(keyword)) &&
		(title2.includes(keyword) || format2.includes(keyword))
	);
	
	// 文字列の類似度も計算
	const titleSimilarity = calculateStringSimilarity(title1, title2);
	const formatSimilarity = calculateStringSimilarity(format1, format2);
	
	return hasCommonKeyword || titleSimilarity > 0.5 || formatSimilarity > 0.5;
}

function calculateStringSimilarity(str1: string, str2: string): number {
	if (str1 === str2) return 1.0;
	if (str1.length === 0 || str2.length === 0) return 0.0;
	
	// Levenshtein距離ベースの類似度計算
	const matrix: number[][] = [];
	const len1 = str1.length;
	const len2 = str2.length;
	
	for (let i = 0; i <= len1; i++) {
		matrix[i] = [i];
	}
	
	for (let j = 0; j <= len2; j++) {
		matrix[0][j] = j;
	}
	
	for (let i = 1; i <= len1; i++) {
		for (let j = 1; j <= len2; j++) {
			if (str1[i - 1] === str2[j - 1]) {
				matrix[i][j] = matrix[i - 1][j - 1];
			} else {
				matrix[i][j] = Math.min(
					matrix[i - 1][j] + 1,     // deletion
					matrix[i][j - 1] + 1,     // insertion
					matrix[i - 1][j - 1] + 1  // substitution
				);
			}
		}
	}
	
	const maxLength = Math.max(len1, len2);
	return 1 - (matrix[len1][len2] / maxLength);
}

// Export functions for local use
export { scrapeEventFinder, generateIcal, fetchExternalEvents, removeDuplicateEvents };
