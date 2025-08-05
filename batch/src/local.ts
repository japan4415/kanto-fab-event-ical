import { writeFileSync } from 'fs';
import { scrapeEventFinder, generateIcal } from './index.js';

async function main() {
	console.log('Running in local mode...');
	try {
		const events = await scrapeEventFinder();
		console.log(`Found ${events.length} events`);
		
		const icalContent = generateIcal(events);
		writeFileSync('calendar.ics', icalContent);
		console.log('Successfully saved calendar.ics locally');
	} catch (error) {
		console.error('Error:', error);
	}
}

main();