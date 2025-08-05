import ical from 'ical-generator';
import { parseHTML } from 'linkedom';

interface FaBEvent {
	title: string;
	eventType: string;
	startDatetime: Date;
	location: string;
	format: string;
	details: string;
}

const ORDINAL_REGEX = /(\d{1,2})(st|nd|rd|th)/gi;
const JST_OFFSET = 9 * 60; // JST is UTC+9

export default {
	async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log('Scheduled event triggered at', controller.cron);
		try {
			const events = await scrapeEventFinder();
			console.log(`Found ${events.length} events`);
			
			const icalContent = generateIcal(events);
			
			await env.BUCKET.put('calendar.ics', icalContent, {
				httpMetadata: {
					contentType: 'text/calendar; charset=utf-8'
				}
			});
			
			console.log('Successfully saved calendar.ical to R1 bucket');
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
		// Create date in JST by adding 9 hours back
		const jstDate = new Date(event.startDatetime.getTime() + (JST_OFFSET * 60000));
		
		calendar.createEvent({
			start: jstDate,
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
				
				// The scraped time is already in JST, so we need to create a proper JST date
				// Subtract 9 hours to get UTC, then the iCal library will handle timezone properly
				startDatetime = new Date(startDatetime.getTime() - (JST_OFFSET * 60000));
				
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
	
	return new Date(parseInt(year, 10), monthIndex, parseInt(day, 10), hour24, parseInt(minute, 10));
}

// Export functions for local use
export { scrapeEventFinder, generateIcal };
