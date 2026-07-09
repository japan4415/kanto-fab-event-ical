import assert from 'node:assert/strict';
import test from 'node:test';

import { generateIcal } from './index.js';

test('generateIcalは有効なiCalフォーマットを出力する', () => {
	const events = [
		{
			title: 'Armory@Test Store',
			eventType: 'Armory',
			startDatetime: new Date('2026-03-22T10:00:00+09:00'),
			location: 'Tokyo, Japan',
			format: 'Classic Constructed',
			details: 'Test event description',
		},
	];

	const result = generateIcal(events);

	assert.ok(result.includes('BEGIN:VCALENDAR'), 'VCALENDARブロックが含まれること');
	assert.ok(result.includes('END:VCALENDAR'), 'VCALENDARブロックが閉じられること');
	assert.ok(result.includes('BEGIN:VEVENT'), 'VEVENTブロックが含まれること');
	assert.ok(result.includes('END:VEVENT'), 'VEVENTブロックが閉じられること');
	assert.ok(result.includes('Kanto FaB Events'), 'カレンダー名が含まれること');
	assert.ok(result.includes('Asia/Tokyo'), 'タイムゾーンが含まれること');
});

test('generateIcalはイベントのサマリーにフォーマットとタイトルを含める', () => {
	const events = [
		{
			title: 'Weekly CC@Fable',
			eventType: 'Classic Constructed',
			startDatetime: new Date('2026-04-01T18:00:00+09:00'),
			location: 'Fable Tokyo',
			format: 'Classic Constructed',
			details: '',
		},
	];

	const result = generateIcal(events);

	assert.ok(
		result.includes('Classic Constructed') && result.includes('Weekly CC@Fable'),
		'SUMMARYにフォーマットとタイトルが含まれること'
	);
});

test('generateIcalは複数イベントを正しく処理する', () => {
	const events = [
		{
			title: 'Event A@Store 1',
			eventType: 'Armory',
			startDatetime: new Date('2026-03-22T10:00:00+09:00'),
			location: 'Location A',
			format: 'Blitz',
			details: 'Details A',
		},
		{
			title: 'Event B@Store 2',
			eventType: 'ProQuest',
			startDatetime: new Date('2026-03-23T14:00:00+09:00'),
			location: 'Location B',
			format: 'Classic Constructed',
			details: 'Details B',
		},
	];

	const result = generateIcal(events);

	const veventCount = (result.match(/BEGIN:VEVENT/g) || []).length;
	assert.equal(veventCount, 2, '2つのVEVENTブロックが存在すること');

	assert.ok(result.includes('Event A@Store 1'), '1つ目のイベントタイトルが含まれること');
	assert.ok(result.includes('Event B@Store 2'), '2つ目のイベントタイトルが含まれること');
});

test('generateIcalは空のイベントリストでも有効なiCalを出力する', () => {
	const result = generateIcal([]);

	assert.ok(result.includes('BEGIN:VCALENDAR'), 'VCALENDARブロックが含まれること');
	assert.ok(result.includes('END:VCALENDAR'), 'VCALENDARブロックが閉じられること');

	const veventCount = (result.match(/BEGIN:VEVENT/g) || []).length;
	assert.equal(veventCount, 0, 'VEVENTブロックが存在しないこと');
});
