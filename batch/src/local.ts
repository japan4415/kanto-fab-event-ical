import { writeFileSync } from 'fs';
import { scrapeEventFinder, generateIcal, fetchExternalEvents, removeDuplicateEvents } from './index.js';

async function main() {
	console.log('Running in local mode...');
	try {
		// Get events from FaB official site
		const officialEvents = await scrapeEventFinder();
		console.log(`Found ${officialEvents.length} official events`);
		
		// Get events from external iCal feeds (local環境)
		const externalEvents = await fetchExternalEvents({ BUCKET: {} as any, ENV: 'local' });
		console.log(`Found ${externalEvents.length} external events`);
		
		// Remove duplicates and combine events
		const uniqueEvents = removeDuplicateEvents(officialEvents, externalEvents);
		console.log(`Total ${uniqueEvents.length} events (after deduplication)`);
		
		const icalContent = generateIcal(uniqueEvents);
		writeFileSync('calendar.ics', icalContent);
		console.log('Successfully saved calendar.ics locally');
	} catch (error) {
		console.error('Error:', error);
	}
}

main();