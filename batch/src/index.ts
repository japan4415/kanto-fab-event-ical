import ical from 'ical-generator';
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

const JST_OFFSET = 9 * 60; // JST is UTC+9

// External iCal feed URLs
const EXTERNAL_ICAL_FEEDS = [
	'https://calendar.google.com/calendar/ical/fable.fabtcg%40gmail.com/public/basic.ics',
	'https://calendar.google.com/calendar/ical/tokyofab.info%40gmail.com/public/basic.ics'
];

export default {
	async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log(`スケジュールされたイベントを開始しました (cron: ${controller.cron})`);
		try {
			// FaB公式サイトからイベント取得
			const officialEvents = await scrapeEventFinder();
			console.log(`公式サイトから ${officialEvents.length} 件のイベントを取得しました`);

			// 外部iCalフィードからイベント取得
			const externalEvents = await fetchExternalEvents(env);
			console.log(`外部カレンダーから ${externalEvents.length} 件のイベントを取得しました`);

			// 重複を削除してイベントを統合
			const uniqueEvents = removeDuplicateEvents(officialEvents, externalEvents);
			console.log(`重複削除後、合計 ${uniqueEvents.length} 件のイベントを処理しました`);

			const icalContent = generateIcal(uniqueEvents);

			await env.BUCKET.put('calendar.ics', icalContent, {
				httpMetadata: {
					contentType: 'text/calendar; charset=utf-8'
				}
			});

			console.log('calendar.ics を R2 バケットに正常に保存しました');
		} catch (error) {
			console.error('スケジュールタスク実行中にエラーが発生しました:', error);
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
	const apiUrl = 'https://gem.fabtcg.com/api/v1/locator/events/';
	const searchQuery = '品川区';
	const MAX_DISTANCE_KM = 50; // 最大距離（km）

	const events: FaBEvent[] = [];
	let currentPage = 1;
	let hasMorePages = true;

	while (hasMorePages) {
		try {
			const params = new URLSearchParams({
				search: searchQuery,
				mode: 'event',
				page: currentPage.toString()
			});

			const response = await fetch(`${apiUrl}?${params}`);
			if (!response.ok) {
				console.error(`APIリクエストが失敗しました (ステータス: ${response.status})`);
				break;
			}

			const data = await response.json() as any;

			// APIレスポンスからイベントを抽出
			if (data.results && Array.isArray(data.results)) {
				for (const event of data.results) {
					try {
						// 距離フィルタリング（50km以内のみ）
						const distance = event.distance || 0;
						const distanceUnit = event.distance_unit || 'km';

						// kmに統一してチェック
						const distanceInKm = distanceUnit === 'km' ? distance : distance * 1.60934; // mile to km

						if (distanceInKm > MAX_DISTANCE_KM) {
							continue; // 50kmより遠いイベントはスキップ
						}

						// イベントの日時をパース (ISO 8601形式)
						const startDatetime = new Date(event.start_time);

						// イベント名と場所を取得
						const eventName = event.nickname || '';
						const storeName = event.organiser_name || '';
						const location = event.address || '';

						// フォーマット情報を取得
						const format = event.format_name || event.tournament_type || 'Unknown';

						events.push({
							title: storeName ? `${eventName}@${storeName}` : eventName,
							eventType: event.tournament_type || eventName,
							startDatetime,
							location,
							format,
							details: event.description || ''
						});
					} catch (error) {
						console.error('イベントのパース中にエラーが発生しました:', error);
						continue;
					}
				}
			}

			// 次のページがあるかチェック
			if (data.next) {
				currentPage++;
			} else {
				hasMorePages = false;
			}
		} catch (error) {
			console.error(`ページ ${currentPage} の取得中にエラーが発生しました:`, error);
			break;
		}
	}

	return events;
}


async function fetchExternalEvents(env?: Env): Promise<FaBEvent[]> {
	const allExternalEvents: FaBEvent[] = [];
	
	for (const feedUrl of EXTERNAL_ICAL_FEEDS) {
		try {
			console.log(`iCalフィードを取得しています: ${feedUrl}`);
			const response = await fetch(feedUrl);

			if (!response.ok) {
				console.error(`iCalフィードの取得に失敗しました ${feedUrl} (ステータス: ${response.status})`);
				continue;
			}

			const icalText = await response.text();
			const events = parseICalEvents(icalText, feedUrl, env);
			console.log(`${feedUrl} から ${events.length} 件のイベントをパースしました`);

			allExternalEvents.push(...events);
		} catch (error) {
			console.error(`iCalフィードの取得中にエラーが発生しました ${feedUrl}:`, error);
		}
	}
	
	return allExternalEvents;
}

function detectEventType(title: string): string {
	const titleLower = title.toLowerCase();
	
	// Project Blue detection (check for full name first)
	if (titleLower.includes('project blue') || titleLower.includes('pb')) {
		return 'Project Blue';
	}
	
	// Classic Constructed detection
	if (titleLower.includes('cc') || titleLower.includes('classic')) {
		return 'Classic Constructed';
	}
	
	// Blitz detection
	if (titleLower.includes('blitz') || titleLower.includes('ブリッツ')) {
		return 'Blitz';
	}
	
	// Living Legend detection
	if (titleLower.includes('living legend') || titleLower.includes('ll')) {
		return 'Living Legend';
	}
	
	// Default fallback
	return 'External Event';
}

function parseICalEvents(icalText: string, source: string, env?: Env): FaBEvent[] {
	const events: FaBEvent[] = [];
	const isCloudflare = (env?.ENV || 'local') === 'cloudflare';
	
	try {
		const jcalData = ICAL.parse(icalText);
		const comp = new ICAL.Component(jcalData);
		const vevents = comp.getAllSubcomponents('vevent');

		console.log(`${source} から ${vevents.length} 件のVEVENTコンポーネントを検出しました`);
		
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
									
									// Detect event type from title
									const eventType = detectEventType(summary);
									
									events.push({
										title: `${summary}@${sourceName}`,
										eventType: eventType,
										startDatetime: occurrenceDate,
										location: location,
										format: eventType === 'External Event' ? 'External' : eventType,
										details: description
									});
								}
								count++;
							}
						} catch (recurError) {
							console.warn('繰り返しイベントの展開中にエラーが発生しました:', recurError);
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
								
							// Detect event type from title
							const eventType = detectEventType(summary);
								
							events.push({
								title: `${summary}@${sourceName}`,
								eventType: eventType,
								startDatetime: adjustedStartDate || new Date(),
								location: location,
								format: eventType === 'External Event' ? 'External' : eventType,
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
							
						// Detect event type from title
						const eventType = detectEventType(summary);
							
						events.push({
							title: `${summary}@${sourceName}`,
							eventType: eventType,
							startDatetime: adjustedStartDate || new Date(),
							location: location,
							format: eventType === 'External Event' ? 'External' : eventType,
							details: description
						});
					}
				}
			} catch (error) {
				console.warn('個別イベントのパース中にエラーが発生しました:', error);
			}
		}
	} catch (error) {
		console.error('iCalデータのパース中にエラーが発生しました:', error);
	}
	
	// 同一ソース内の外部イベントの重複を削除
	const uniqueEvents = removeDuplicateExternalEvents(events);
	console.log(`外部イベントの重複削除: ${events.length} 件 → ${uniqueEvents.length} 件`);
	
	return uniqueEvents;
}

function removeDuplicateExternalEvents(events: FaBEvent[]): FaBEvent[] {
	const uniqueEvents: FaBEvent[] = [];
	
	for (const event of events) {
		const isDuplicate = uniqueEvents.some(existing => isDuplicateEvent(event, existing));
		if (!isDuplicate) {
			uniqueEvents.push(event);
		} else {
			console.log(`外部イベントの重複を削除しました: ${event.title} が既存のイベントと一致`);
		}
	}
	
	return uniqueEvents;
}

function removeDuplicateEvents(officialEvents: FaBEvent[], externalEvents: FaBEvent[]): FaBEvent[] {
	// 適切な期間（過去1ヶ月〜未来6ヶ月）にイベントを絞り込み
	const now = new Date();
	const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
	const sixMonthsLater = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);

	const recentExternalEvents = externalEvents.filter(e =>
		e.startDatetime >= oneMonthAgo && e.startDatetime <= sixMonthsLater
	);

	console.log(`期間によるフィルタリング: ${externalEvents.length} 件 → ${recentExternalEvents.length} 件 (対象期間内)`);

	const uniqueEvents = [...recentExternalEvents]; // 外部イベントを優先
	const duplicateCount = { removed: 0, kept: 0 };

	for (const officialEvent of officialEvents) {
		const matchingExternal = recentExternalEvents.find(externalEvent =>
			isDuplicateEvent(officialEvent, externalEvent)
		);

		if (matchingExternal) {
			duplicateCount.removed++;
			console.log(`重複イベントを削除しました: ${officialEvent.title} が ${matchingExternal.title} と一致`);
		} else {
			uniqueEvents.push(officialEvent);
			duplicateCount.kept++;
		}
	}

	console.log(`重複削除の結果: ${duplicateCount.removed} 件削除、${duplicateCount.kept} 件の公式イベントを保持しました`);
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
	const title1 = event1.title.toLowerCase();
	const title2 = event2.title.toLowerCase();
	
	const isSameVenue = (
		// Both locations contain the same venue name
		(location1.includes('fable') && location2.includes('fable')) ||
		(location1.includes('tokyo fab') && location2.includes('tokyo fab')) ||
		(location1.includes('cardon') && location2.includes('cardon')) ||
		(location1.includes('amenity dream') && location2.includes('amenity dream')) ||
		// Or both titles contain the same venue name (handle empty location case)
		(title1.includes('@fable') && title2.includes('@fable')) ||
		(title1.includes('@tokyo fab') && title2.includes('@tokyo fab')) ||
		(title1.includes('@cardon') && title2.includes('@cardon')) ||
		(title1.includes('@amenity dream') && title2.includes('@amenity dream'))
	);
	
	if (!isSameVenue) {
		return false;
	}
	
	// フォーマットの比較（同じフォーマットかどうか）
	const format1 = event1.format.toLowerCase();
	const format2 = event2.format.toLowerCase();
	
	// フォーマットが同じかチェック
	const isSameFormat = (
		format1 === format2 ||
		event1.eventType.toLowerCase() === event2.eventType.toLowerCase()
	);
	
	if (!isSameFormat) {
		return false;
	}
	
	// 共通キーワードをチェック
	const commonKeywords = ['learn to play', 'armory', 'blitz', 'classic constructed', 'pro quest', 'draft', 'on demand', 'cc', 'll', 'pb'];
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
