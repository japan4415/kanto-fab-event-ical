import { writeFileSync } from 'fs';
import { scrapeEventFinder, generateIcal } from './index.js';

async function main() {
	console.log('Running in local mode...');
	try {
		// Get events from FaB official site
		const officialEvents = await scrapeEventFinder();
		console.log(`Found ${officialEvents.length} official events`);

		const icalContent = generateIcal(officialEvents);
		writeFileSync('calendar.ics', icalContent);
		console.log('Successfully saved calendar.ics locally');
	} catch (error) {
		console.error('Error:', error);
	}
}

main();
