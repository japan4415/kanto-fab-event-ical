import ical from 'ical-generator';

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

export default {
	async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log(`スケジュールされたイベントを開始しました (cron: ${controller.cron})`);
		try {
			// FaB公式サイトからイベント取得
			const officialEvents = await scrapeEventFinder(env);
			console.log(`公式サイトから ${officialEvents.length} 件のイベントを取得しました`);

			const icalContent = generateIcal(officialEvents);

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

// Export functions for local use
export { scrapeEventFinder, generateIcal };
