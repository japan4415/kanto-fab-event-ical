import requests
import re
from datetime import datetime
from requests.models import Response
from bs4 import BeautifulSoup as bs4
from pydantic import BaseModel

from zoneinfo import ZoneInfo

from pprint import pprint

from icalendar import Calendar, Event

_ORDINAL = re.compile(r'(\d{1,2})(st|nd|rd|th)', re.IGNORECASE)
JST = ZoneInfo("Asia/Tokyo")

class FaBEvent(BaseModel):
    title: str
    event_type: str
    start_datetime: datetime
    location: str
    format: str
    details: str

def main():
    print("Hello from batch!")
    scrape_event_finder()
    
def scrape_event_finder():
    url = "https://fabtcg.com/ja/events/"
    params = {
        "format": "",
        "type": "",
        "distance": "50",
        "query": "日本、東京都品川区上大崎２丁目１６ 目黒駅",
        "sort": "date",
        "mode": "event",
        "page": 1,
    }
    page: Response = requests.get(url, params=params)
    bs4_page = bs4(page.text, "html.parser")
    final_as = bs4_page.select("body > article > div > div.container.paginator > div > div > div.pagination-arrow.pagination-arrow-next.text-right > li > a")
    total_page_count = int(final_as[0]["href"].split("&")[-1].split("=")[1])

    events: list[FaBEvent] = []
    for page_number in range(0, total_page_count):
        params["page"] = page_number + 1
        page: Response = requests.get(url, params=params)
        bs4_page = bs4(page.text, "html.parser")
        event_details = bs4_page.select("body > article > div > div.event")
        for event_detail in event_details:
            inside_div = event_detail.select("div.text-lg-left")[0]
            title = inside_div.select("h2")[0].text.strip()
            title_datas = title.split("\n")
            datetime_format_p = event_detail.select("p")[0]
            # parse the start datetime from Sun 21st Sep, 3:30 PM
            year = datetime.now().year
            start_datetime_cleaned = _ORDINAL.sub(r"\1", datetime_format_p.text).strip().split("\n")[0].strip().replace(",", f" {year},")
            try:
                start_datetime = datetime.strptime(
                    start_datetime_cleaned,
                    "%a %d %b %Y, %I %p"
                )
            except:
                try:
                    start_datetime = datetime.strptime(
                        start_datetime_cleaned,
                        "%a %d %b %Y, %I:%M %p"
                    )
                except:
                    raise ValueError(f"Unable to parse datetime: {start_datetime_cleaned}")
            start_datetime = start_datetime.replace(tzinfo=JST)
            locate_p = event_detail.select("p")[1]
            events.append(
                FaBEvent(
                    title=f"{title_datas[1].strip()}@{title_datas[3].strip()}",
                    event_type=title_datas[1].strip(),
                    start_datetime=start_datetime,
                    location=locate_p.text.strip(),
                    format=datetime_format_p.text.strip().split("\n")[2].strip(),
                    details="",
                )
            )
    pprint(events)

    cal = Calendar()
    for event in events:
        print(event.location)
        cal_event = Event()
        cal_event.add("summary", f"【{event.format}】{event.title}")
        cal_event.add("dtstart", event.start_datetime)
        cal_event.add("location", event.location)
        cal_event.add("description", event.details)
        cal.add_component(cal_event)

    with open('example.ics', 'wb') as f:
        f.write(cal.to_ical())

if __name__ == "__main__":
    main()
