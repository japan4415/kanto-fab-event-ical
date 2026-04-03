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
const MILLISECONDS_PER_MINUTE = 60 * 1000;
const MILLISECONDS_PER_DAY = 24 * 60 * MILLISECONDS_PER_MINUTE;
const EXTERNAL_LOOKAHEAD_DAYS = 30;
const ICAL_CACHE_TTL_SECONDS = 6 * 60 * 60; // 6時間
const DUPLICATE_TIME_THRESHOLD_MS = 30 * MILLISECONDS_PER_MINUTE;
const DUPLICATE_TIME_BUCKET_MS = DUPLICATE_TIME_THRESHOLD_MS;
const RECURRENCE_EXPANSION_LIMIT = 50;
const EXCLUDED_EXTERNAL_KEYWORDS = ['grand archive', '定休日'];
const NON_GAME_KEYWORDS = ['定休日', '休み', '休業', 'closed'];
const COMMON_DUPLICATE_KEYWORDS = ['learn to play', 'armory', 'blitz', 'classic constructed', 'pro quest', 'draft', 'on demand', 'cc', 'll', 'pb'];
const KNOWN_VENUES = [
	{ name: 'fable', tokens: ['fable'] },
	{ name: 'tokyo fab', tokens: ['tokyo fab'] },
	{ name: 'cardon', tokens: ['cardon'] },
	{ name: 'amenity dream', tokens: ['amenity dream'] }
] as const;

// External iCal feed URLs
const EXTERNAL_ICAL_FEEDS = [
	'https://calendar.google.com/calendar/ical/fable.fabtcg%40gmail.com/public/basic.ics',
	'https://calendar.google.com/calendar/ical/tokyofab.info%40gmail.com/public/basic.ics'
];

type DuplicateIndex = Map<string, FaBEvent[]>;

export default {
	async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log(`スケジュールされたイベントを開始しました (cron: ${controller.cron})`);
		try {
			const now = new Date();

			// FaB公式サイトからイベント取得
			const officialEvents = await scrapeEventFinder(env);
			console.log(`公式サイトから ${officialEvents.length} 件のイベントを取得しました`);

			// 外部iCalフィードからイベント取得
			const externalEvents = await fetchExternalEvents(env, now);
			console.log(`外部カレンダーから ${externalEvents.length} 件のイベントを取得しました`);

			// 重複を削除してイベントを統合
			const uniqueEvents = removeDuplicateEvents(officialEvents, externalEvents, now);
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

async function scrapeEventFinder(env?: Env): Promise<FaBEvent[]> {
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

						// イベントの日時をパース
						// APIのタイムゾーン情報が不正確なため、タイムゾーンを除去してJSTとして扱う
						const timeWithoutTz = event.start_time.replace(/[+-]\d{2}:\d{2}$/, '');
						let startDatetime: Date;
						if (env?.ENV === 'cloudflare') {
							startDatetime = new Date(timeWithoutTz + '+00:00');
						} else {
							startDatetime = new Date(timeWithoutTz + '+09:00');
						}

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


function icalCacheKey(feedUrl: string): string {
	return `cache/ical/${encodeURIComponent(feedUrl)}`;
}

async function fetchICalTextWithCache(feedUrl: string, bucket: R2Bucket | undefined): Promise<string | null> {
	// キャッシュからの読み込みを試行
	if (bucket) {
		try {
			const cached = await bucket.get(icalCacheKey(feedUrl));
			if (cached) {
				const age = (Date.now() - (cached.uploaded?.getTime() ?? 0)) / 1000;
				if (age < ICAL_CACHE_TTL_SECONDS) {
					console.log(`iCalフィードをキャッシュから取得しました: ${feedUrl} (経過: ${Math.round(age / 60)}分)`);
					return await cached.text();
				}
			}
		} catch (error) {
			console.warn('キャッシュ読み込み中にエラーが発生しました:', error);
		}
	}

	// フィードを取得
	console.log(`iCalフィードを取得しています: ${feedUrl}`);
	const response = await fetch(feedUrl);

	if (!response.ok) {
		console.error(`iCalフィードの取得に失敗しました ${feedUrl} (ステータス: ${response.status})`);
		return null;
	}

	const icalText = await response.text();

	// キャッシュに保存
	if (bucket) {
		try {
			await bucket.put(icalCacheKey(feedUrl), icalText, {
				httpMetadata: { contentType: 'text/calendar; charset=utf-8' }
			});
		} catch (error) {
			console.warn('キャッシュ保存中にエラーが発生しました:', error);
		}
	}

	return icalText;
}

async function fetchExternalEvents(env?: Env, now = new Date()): Promise<FaBEvent[]> {
	const bucket = env?.BUCKET;
	const results = await Promise.allSettled(
		EXTERNAL_ICAL_FEEDS.map(async (feedUrl) => {
			const icalText = await fetchICalTextWithCache(feedUrl, bucket);
			if (!icalText) return [];

			const events = parseICalEvents(icalText, feedUrl, env, now);
			console.log(`${feedUrl} から ${events.length} 件のイベントをパースしました`);
			return events;
		})
	);

	const allExternalEvents: FaBEvent[] = [];
	for (const result of results) {
		if (result.status === 'fulfilled') {
			allExternalEvents.push(...result.value);
		} else {
			console.error('iCalフィードの取得中にエラーが発生しました:', result.reason);
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

function parseICalEvents(icalText: string, source: string, env?: Env, now = new Date()): FaBEvent[] {
	const events: FaBEvent[] = [];
	const isCloudflare = (env?.ENV || 'local') === 'cloudflare';
	const lookaheadEnd = getExternalLookaheadEnd(now);
	
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
				
				if (!startDate || !summary || shouldExcludeExternalEvent(summary, description)) {
					continue; // このイベントをスキップ
				}
				
				// Handle recurring events by expanding them
				if (event.isRecurring()) {
					try {
						const recurExpander = new ICAL.RecurExpansion({
							component: event.component,
							dtstart: event.startDate
						});
						
						let count = 0;
						let next;
						while ((next = recurExpander.next()) && count < RECURRENCE_EXPANSION_LIMIT) {
							count++;
							const occurrenceDate = adjustExternalStartDate(next.toJSDate(), isCloudflare);
							if (!occurrenceDate) {
								continue;
							}

							if (occurrenceDate > lookaheadEnd) {
								break;
							}

							if (!isWithinExternalLookaheadWindow(occurrenceDate, now, lookaheadEnd)) {
								continue;
							}

							events.push(createExternalEvent(summary, source, location, description, occurrenceDate));
						}
					} catch (recurError) {
						console.warn('繰り返しイベントの展開中にエラーが発生しました:', recurError);
						const adjustedStartDate = adjustExternalStartDate(startDate, isCloudflare);
						if (adjustedStartDate && isWithinExternalLookaheadWindow(adjustedStartDate, now, lookaheadEnd)) {
							events.push(createExternalEvent(summary, source, location, description, adjustedStartDate));
						}
					}
				} else {
					const adjustedStartDate = adjustExternalStartDate(startDate, isCloudflare);
					if (adjustedStartDate && isWithinExternalLookaheadWindow(adjustedStartDate, now, lookaheadEnd)) {
						events.push(createExternalEvent(summary, source, location, description, adjustedStartDate));
					}
				}
			} catch (error) {
				console.warn('個別イベントのパース中にエラーが発生しました:', error);
			}
		}
	} catch (error) {
		console.error('iCalデータのパース中にエラーが発生しました:', error);
	}
	
	return removeDuplicateExternalEvents(events);
}

function removeDuplicateExternalEvents(events: FaBEvent[]): FaBEvent[] {
	const uniqueEvents: FaBEvent[] = [];
	const duplicateIndex = new Map<string, FaBEvent[]>();
	let removedCount = 0;
	
	for (const event of events) {
		const isDuplicate = getDuplicateCandidates(duplicateIndex, event)
			.some(existing => isDuplicateEvent(event, existing));

		if (!isDuplicate) {
			uniqueEvents.push(event);
			addToDuplicateIndex(duplicateIndex, event);
			continue;
		}

		removedCount++;
	}

	console.log(`外部イベントの重複削除: ${events.length} 件 → ${uniqueEvents.length} 件 (${removedCount} 件削除)`);
	
	return uniqueEvents;
}

function removeDuplicateEvents(officialEvents: FaBEvent[], externalEvents: FaBEvent[], now = new Date()): FaBEvent[] {
	const lookaheadEnd = getExternalLookaheadEnd(now);
	const recentExternalEvents = externalEvents.filter(e =>
		isWithinExternalLookaheadWindow(e.startDatetime, now, lookaheadEnd)
	);

	console.log(`期間によるフィルタリング: ${externalEvents.length} 件 → ${recentExternalEvents.length} 件 (外部イベント: 未来${EXTERNAL_LOOKAHEAD_DAYS}日)`);

	const uniqueEvents = [...recentExternalEvents]; // 外部イベントを優先
	const externalDuplicateIndex = buildDuplicateIndex(recentExternalEvents);
	const duplicateCount = { removed: 0, kept: 0 };

	for (const officialEvent of officialEvents) {
		const matchingExternal = getDuplicateCandidates(externalDuplicateIndex, officialEvent).find(externalEvent =>
			isDuplicateEvent(officialEvent, externalEvent)
		);

		if (matchingExternal) {
			duplicateCount.removed++;
		} else {
			uniqueEvents.push(officialEvent);
			duplicateCount.kept++;
		}
	}

	console.log(`重複削除の結果: ${duplicateCount.removed} 件削除、${duplicateCount.kept} 件の公式イベントを保持しました`);
	return uniqueEvents;
}

function createExternalEvent(
	summary: string,
	source: string,
	location: string,
	description: string,
	startDatetime: Date
): FaBEvent {
	const eventType = detectEventType(summary);

	return {
		title: `${summary}@${getExternalSourceName(source)}`,
		eventType,
		startDatetime,
		location,
		format: eventType === 'External Event' ? 'External' : eventType,
		details: description
	};
}

function getExternalSourceName(source: string): string {
	if (source.includes('fable.fabtcg')) {
		return 'Fable';
	}

	if (source.includes('tokyofab.info')) {
		return 'Tokyo FAB';
	}

	return 'External';
}

function shouldExcludeExternalEvent(summary: string, description: string): boolean {
	const summaryLower = summary.toLowerCase();
	const descriptionLower = description.toLowerCase();

	return EXCLUDED_EXTERNAL_KEYWORDS.some(keyword =>
		summaryLower.includes(keyword) || descriptionLower.includes(keyword)
	);
}

function adjustExternalStartDate(startDate: Date | undefined, isCloudflare: boolean): Date | undefined {
	if (!startDate) {
		return undefined;
	}

	if (!isCloudflare) {
		return startDate;
	}

	return new Date(startDate.getTime() + (JST_OFFSET * MILLISECONDS_PER_MINUTE));
}

function getExternalLookaheadEnd(now: Date): Date {
	return new Date(now.getTime() + (EXTERNAL_LOOKAHEAD_DAYS * MILLISECONDS_PER_DAY));
}

function isWithinExternalLookaheadWindow(startDatetime: Date, now: Date, lookaheadEnd = getExternalLookaheadEnd(now)): boolean {
	return startDatetime >= now && startDatetime <= lookaheadEnd;
}

function buildDuplicateIndex(events: FaBEvent[]): DuplicateIndex {
	const index = new Map<string, FaBEvent[]>();

	for (const event of events) {
		addToDuplicateIndex(index, event);
	}

	return index;
}

function addToDuplicateIndex(index: DuplicateIndex, event: FaBEvent): void {
	const bucketKey = getDuplicateBucketKey(event);
	const existingBucket = index.get(bucketKey);

	if (existingBucket) {
		existingBucket.push(event);
		return;
	}

	index.set(bucketKey, [event]);
}

function getDuplicateCandidates(index: DuplicateIndex, event: FaBEvent): FaBEvent[] {
	const candidates: FaBEvent[] = [];

	for (const key of getDuplicateCandidateKeys(event)) {
		const bucketEvents = index.get(key);
		if (bucketEvents) {
			candidates.push(...bucketEvents);
		}
	}

	return candidates;
}

function getDuplicateCandidateKeys(event: FaBEvent): string[] {
	const bucketPrefix = getDuplicateBucketPrefix(event);
	const timeBucket = getDuplicateTimeBucket(event.startDatetime);

	return [timeBucket - 1, timeBucket, timeBucket + 1].map(bucket =>
		`${bucketPrefix}|${bucket}`
	);
}

function getDuplicateBucketKey(event: FaBEvent): string {
	return `${getDuplicateBucketPrefix(event)}|${getDuplicateTimeBucket(event.startDatetime)}`;
}

function getDuplicateBucketPrefix(event: FaBEvent): string {
	return `${normalizeVenue(event)}|${normalizeFormat(event)}`;
}

function getDuplicateTimeBucket(startDatetime: Date): number {
	return Math.floor(startDatetime.getTime() / DUPLICATE_TIME_BUCKET_MS);
}

function normalizeVenue(event: FaBEvent): string {
	const searchTargets = [event.location.toLowerCase(), event.title.toLowerCase()];

	for (const venue of KNOWN_VENUES) {
		if (searchTargets.some(target => venue.tokens.some(token => target.includes(token)))) {
			return venue.name;
		}
	}

	return 'unknown';
}

function normalizeFormat(event: Pick<FaBEvent, 'format' | 'eventType'>): string {
	const candidates = [event.format, event.eventType]
		.map(value => value.toLowerCase().trim())
		.filter(Boolean);

	for (const candidate of candidates) {
		if (candidate.includes('project blue') || candidate.includes('pb')) {
			return 'project blue';
		}

		if (candidate.includes('classic constructed') || candidate.includes('cc') || candidate.includes('classic')) {
			return 'classic constructed';
		}

		if (candidate.includes('blitz') || candidate.includes('ブリッツ')) {
			return 'blitz';
		}

		if (candidate.includes('living legend') || candidate.includes('ll')) {
			return 'living legend';
		}

		if (candidate.includes('learn to play')) {
			return 'learn to play';
		}

		if (candidate.includes('armory')) {
			return 'armory';
		}

		if (candidate.includes('pro quest')) {
			return 'pro quest';
		}

		if (candidate.includes('draft')) {
			return 'draft';
		}

		if (candidate.includes('on demand')) {
			return 'on demand';
		}
	}

	return candidates[0] || 'unknown';
}

function isDuplicateEvent(event1: FaBEvent, event2: FaBEvent): boolean {
	const isNonGameEvent = (event: FaBEvent) => 
		NON_GAME_KEYWORDS.some(keyword => 
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
	
	const title1 = event1.title.toLowerCase();
	const title2 = event2.title.toLowerCase();

	const venue1 = normalizeVenue(event1);
	const venue2 = normalizeVenue(event2);
	const isSameVenue = venue1 !== 'unknown' && venue1 === venue2;
	
	if (!isSameVenue) {
		return false;
	}
	
	// フォーマットの比較（同じフォーマットかどうか）
	const format1 = event1.format.toLowerCase();
	const format2 = event2.format.toLowerCase();
	
	// フォーマットが同じかチェック
	const isSameFormat = (
		format1 === format2 ||
		event1.eventType.toLowerCase() === event2.eventType.toLowerCase() ||
		normalizeFormat(event1) === normalizeFormat(event2)
	);
	
	if (!isSameFormat) {
		return false;
	}
	
	// 共通キーワードをチェック
	const hasCommonKeyword = COMMON_DUPLICATE_KEYWORDS.some(keyword => 
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

	// トークンベースのJaccard類似度（O(n+m)）
	const tokens1 = new Set(str1.split(/[\s@\-\/【】]+/).filter(Boolean));
	const tokens2 = new Set(str2.split(/[\s@\-\/【】]+/).filter(Boolean));

	if (tokens1.size === 0 || tokens2.size === 0) return 0.0;

	let intersection = 0;
	for (const token of tokens1) {
		if (tokens2.has(token)) intersection++;
	}

	return intersection / (tokens1.size + tokens2.size - intersection);
}

// Export functions for local use
export { EXTERNAL_LOOKAHEAD_DAYS, scrapeEventFinder, generateIcal, fetchExternalEvents, parseICalEvents, removeDuplicateEvents };
