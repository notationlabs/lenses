# Lenses

An agent that needs structured data from a webpage today has three choices: hope the service ships an MCP server, pay a vision model to drive a browser, or write yet another private scraper. The first leaves most of the web uncovered, the second taxes every interaction, and the third produces output no other agent can reuse — so the long tail of useful pages stays effectively closed to agents, and the work of opening any one of them sits with whichever team needs it most. **Every webpage is already a function from URL to value; making *that function* a URL too turns the web into one typed graph of callable definitions, every one of them a file in a public GitHub repository.** A small community publishing one-file lens definitions to gists can then give every agent on earth typed, permissioned access to any site that anyone has cared to describe.

---

**Defence.**

- *Won't this be just another scraper format?* A lens returns a typed graph: every field is either a primitive or another lens, so an agent walks from a tweet to its author to the author's followers without writing glue between calls.
- *Why will third parties author lenses?* The same incentive that produces Tampermonkey scripts and uBlock filter lists — a user wants the site to work for their own agent, and a one-file gist costs nothing to publish.
- *Won't sites block this?* A lens runs inside the user's own browser session under their own login; blocking it means blocking the user.
- *Won't lenses constantly break?* Each lens declares three resolution strategies — intercept, DOM, LLM — and the host falls through to the next when the cheaper layer misses. A broken intercept becomes a slower call rather than a failed one, and the LLM's transcripts are the material a maintainer uses to repair the cheaper layers.

**Related work.**

- *Scrapers.* Private, per-team, no shared shape. Lenses generalise the calling convention.
- *MCP.* Typed, but authorship is gated on the service. Lenses move authorship outside the service.
- *Vision browser agents.* General, but pay an LLM per step. Lenses make the LLM the last resort.
- *Tampermonkey / uBlock / Userstyles.* Prove the social model works. Lenses add a typed return shape on top of the same model.
