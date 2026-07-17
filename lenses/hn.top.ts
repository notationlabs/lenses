import {
  defineLens,
  dom,
  expr,
  lens,
  llm,
  seconds,
  shape,
  stream,
  string,
  url,
} from "@djgrant/lens";

export default defineLens({
  lens: "hn/top",
  version: 1,
  description:
    "Front-page stories on Hacker News. Each story links onward to hn/item via item_url. Paginated: next_page is the following page of stories (null on the last page).",
  accepts: [
    url`https://news.ycombinator.com/`,
    url`https://news.ycombinator.com/news*`,
  ],
  returns: shape({
    stories: stream({
      title: string,
      url: string,
      id: string,
      score: string,
      comments: string,
      item_url: lens("hn/item@v1"),
    }),
    next_page: lens("hn/top@v1"),
  }),
  outcomes: {
    not_found: null,
  },
  effects: {
    reads: ["news.ycombinator.com"],
    writes: [],
    idempotent: true,
    cache: seconds(60),
  },
  resolve: [
    dom({
      item: ".athing",
      fields: {
        id: { selector: ":self", attr: "id" },
        title: { selector: ".titleline > a" },
        url: { selector: ".titleline > a", attr: "href" },
        score: { selector: ".score", sibling: true },
        comments: { selector: ".subline > a:last-child", sibling: true },
      },
      post: expr(
        '{ "stories": $map($, function($v) { $merge([$v, {"item_url": "https://news.ycombinator.com/item?id=" & $v.id}]) }) }'
      ),
    }),
    dom({
      fields: {
        next_page: { selector: "a.morelink", attr: "href" },
      },
    }),
    llm({
      prompt:
        "Extract this Hacker News front page as {stories, next_page}. stories is the ranked list; for each story return title, url, id, score, comments (e.g. '42 comments'), and item_url (https://news.ycombinator.com/item?id=<id>). next_page is the href of the bottom 'More' link (the next page of stories) if present, otherwise null.",
    }),
  ],
});
