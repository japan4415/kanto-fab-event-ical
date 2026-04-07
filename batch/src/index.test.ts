import assert from 'node:assert/strict';
import test from 'node:test';

import { EXTERNAL_LOOKAHEAD_DAYS, parseICalEvents, removeDuplicateEvents } from './index.js';

const TOKYO_FAB_SOURCE = 'https://calendar.google.com/calendar/ical/tokyofab.info%40gmail.com/public/basic.ics';
const LOCAL_ENV = { BUCKET: {} as any, ENV: 'local' as const };
const LOOKAHEAD_WINDOW_MS = EXTERNAL_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;

function buildIcs(events: string[]): string {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//kanto-fab-event-ical//tests//EN',
		...events,
		'END:VCALENDAR'
	].join('\r\n');
}

function buildEvent({
	uid,
	dtstart,
	summary,
	location,
	description = '',
	rrule,
}: {
	uid: string;
	dtstart: string;
	summary: string;
	location: string;
	description?: string;
	rrule?: string;
}): string {
	const lines = [
		'BEGIN:VEVENT',
		`UID:${uid}`,
		'DTSTAMP:20260301T000000Z',
		`DTSTART:${dtstart}`,
		`SUMMARY:${summary}`,
		`LOCATION:${location}`,
	];

	if (description) {
		lines.push(`DESCRIPTION:${description}`);
	}

	if (rrule) {
		lines.push(`RRULE:${rrule}`);
	}

	lines.push('END:VEVENT');
	return lines.join('\r\n');
}

test('繰り返し外部イベントは未来30日以内だけ展開する', () => {
	const now = new Date('2026-03-22T00:00:00Z');
	const lookaheadEnd = new Date(now.getTime() + LOOKAHEAD_WINDOW_MS);
	const icalText = buildIcs([
		buildEvent({
			uid: 'recurring-1',
			dtstart: '20260301T100000Z',
			summary: 'Weekly Blitz',
			location: 'Tokyo FAB',
			rrule: 'FREQ=WEEKLY;COUNT=10',
		}),
	]);

	const events = parseICalEvents(icalText, TOKYO_FAB_SOURCE, LOCAL_ENV, now);

	assert.equal(events.length, 5);
	for (const event of events) {
		assert.ok(event.startDatetime >= now);
		assert.ok(event.startDatetime <= lookaheadEnd);
	}
});

test('単発の外部イベントは未来30日を超えると除外される', () => {
	const now = new Date('2026-03-22T00:00:00Z');
	const icalText = buildIcs([
		buildEvent({
			uid: 'one-off-1',
			dtstart: '20260510T100000Z',
			summary: 'Monthly CC',
			location: 'Tokyo FAB',
		}),
	]);

	const events = parseICalEvents(icalText, TOKYO_FAB_SOURCE, LOCAL_ENV, now);

	assert.equal(events.length, 0);
});

test('同一店舗・同一フォーマット・30分以内の公式イベントは外部イベントに吸収される', () => {
	const now = new Date('2026-03-22T00:00:00Z');
	const externalEvents = [
		{
			title: 'Wednesday CC@Tokyo FAB',
			eventType: 'Classic Constructed',
			startDatetime: new Date('2026-03-22T10:00:00Z'),
			location: 'Tokyo FAB',
			format: 'Classic Constructed',
			details: '',
		},
	];
	const officialEvents = [
		{
			title: 'Armory@Tokyo FAB',
			eventType: 'Armory',
			startDatetime: new Date('2026-03-22T10:20:00Z'),
			location: 'Tokyo FAB',
			format: 'Classic Constructed',
			details: '',
		},
	];

	const merged = removeDuplicateEvents(officialEvents, externalEvents, now);

	assert.equal(merged.length, 1);
	assert.equal(merged[0]?.title, externalEvents[0]?.title);
});

test('RRULE UNTILが過去日付の繰り返しイベントはスキップされる', () => {
	const now = new Date('2026-03-22T00:00:00Z');
	const icalText = buildIcs([
		buildEvent({
			uid: 'past-until-1',
			dtstart: '20230101T100000Z',
			summary: 'Old Weekly Blitz',
			location: 'Tokyo FAB',
			rrule: 'FREQ=WEEKLY;UNTIL=20250101T000000Z',
		}),
	]);

	const events = parseICalEvents(icalText, TOKYO_FAB_SOURCE, LOCAL_ENV, now);

	assert.equal(events.length, 0);
});

test('RRULE UNTILが未来日付の繰り返しイベントはスキップされない', () => {
	const now = new Date('2026-03-22T00:00:00Z');
	const icalText = buildIcs([
		buildEvent({
			uid: 'future-until-1',
			dtstart: '20260322T100000Z',
			summary: 'Active Weekly CC',
			location: 'Tokyo FAB',
			rrule: 'FREQ=WEEKLY;UNTIL=20260501T000000Z',
		}),
	]);

	const events = parseICalEvents(icalText, TOKYO_FAB_SOURCE, LOCAL_ENV, now);

	assert.ok(events.length > 0, `期待: 1件以上のイベント、実際: ${events.length}件`);
});

test('RRULE UNTILなし（無期限）の繰り返しイベントはスキップされない', () => {
	const now = new Date('2026-03-22T00:00:00Z');
	const icalText = buildIcs([
		buildEvent({
			uid: 'no-until-1',
			dtstart: '20260322T100000Z',
			summary: 'Ongoing Weekly Blitz',
			location: 'Tokyo FAB',
			rrule: 'FREQ=WEEKLY;COUNT=10',
		}),
	]);

	const events = parseICalEvents(icalText, TOKYO_FAB_SOURCE, LOCAL_ENV, now);

	assert.ok(events.length > 0, `期待: 1件以上のイベント、実際: ${events.length}件`);
});

test('店舗またはフォーマットが違う公式イベントは重複扱いしない', () => {
	const now = new Date('2026-03-22T00:00:00Z');
	const externalEvents = [
		{
			title: 'Wednesday CC@Tokyo FAB',
			eventType: 'Classic Constructed',
			startDatetime: new Date('2026-03-22T10:00:00Z'),
			location: 'Tokyo FAB',
			format: 'Classic Constructed',
			details: '',
		},
	];
	const officialEvents = [
		{
			title: 'Blitz Night@Tokyo FAB',
			eventType: 'Blitz',
			startDatetime: new Date('2026-03-22T10:15:00Z'),
			location: 'Tokyo FAB',
			format: 'Blitz',
			details: '',
		},
		{
			title: 'CC Armory@Fable',
			eventType: 'Armory',
			startDatetime: new Date('2026-03-22T10:10:00Z'),
			location: 'Fable',
			format: 'Classic Constructed',
			details: '',
		},
	];

	const merged = removeDuplicateEvents(officialEvents, externalEvents, now);

	assert.equal(merged.length, 3);
	assert.ok(merged.some(event => event.title === 'Blitz Night@Tokyo FAB'));
	assert.ok(merged.some(event => event.title === 'CC Armory@Fable'));
});
