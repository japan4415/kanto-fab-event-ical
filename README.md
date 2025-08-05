# kanto-fab-event-ical

このアプリはFlesh and Bloodの公式サイトにあるEventのカレンダーをical形式で提供するアプリである。
アプリはbatchとserverで成り立ち、それぞれ下記のような挙動をする。

## batch
1時間に1回、Flesh and Bloodの公式サイトにあるEvent Finderから目黒駅からhoge km以内で行われるイベント情報を取得し、ical形式でオブジェクトストレージへ書き込む。