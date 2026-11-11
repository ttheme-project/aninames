# Roadmap

What to improve next, each with what was seen or measured when it came up (2026-11-02, UTC). Since 2026-11-01 Bangumi is the spine: only its works and characters are entities and only its data gives structure; every other source attaches names, ids and tags. The first group keeps the releases running; the second fixes what a consumer shows; the last guards against regressions. Effort is a rough guess: small, medium or large.

## Keep the build and the releases running

### 1. Danbooru is frozen at 2026-10-03

Danbooru has refused scripted requests (Cloudflare 403) since 2026-10-30, so builds stage the 10-03 raw data and read the post counts in `data/copyrights.json.gz`, counted once from a public copy. Since the spine it only supplies tags, aliases and post counts, never entities, so a frozen Danbooru no longer changes what the index holds; tags created since then are missing, and 2,339 tags with 50+ posts that no Bangumi character took on 2026-11-01 have no counts, and `tagged` and `cast` order by older post counts.

- The public copy `scripts/copyrights.py` reads was last modified 2026-08-09 (checked 2026-11-02), older than the 10-03 tags, so running it again gains nothing until a newer copy appears.
- Options: an API key (an account owner's), or Danbooru's BigQuery export (tags, aliases, implications).
- On 2026-11-11 Danbooru is in maintenance and its servers do not answer, so no request is worth sending until it is back. The release notes (`NOTICE.md`) and `stats.json` say the day its data is from, and the audit warns once that is two weeks behind the build; it never fails a release.
- Effort: medium.

## What a consumer shows

### 2. Given-name tails

A given name alone still lists every Bangumi namesake: `エミリア` returns Re:Zero's Emilia first and nine other Emilias after her, most of them eroge heroines. Keeping only characters with at least 20 Bangumi collects (11,259 of 213,713) cut that list from 10 to 5 with the same first hit on 15 such queries. ttheme shows no such list today: its work-scoped search asks for 50 characters and filters them by the work, so a floor would risk more than it saves. Left until a consumer shows the tail.

- Effort: small to medium.

### 3. Plain tags that take a namesake

A tag with no qualifier still takes a one-word namesake anywhere in Bangumi when the works its copyright reaches hold no such character, because that keeps `wario`, `wooloo` and `poring`; it also keeps `dark_sakura` on キングダム's 黒桜. Qualified tags lost this on 2026-11-02 (about 450, most of them wrong, a few right like `vergilius_(project_moon)`).

- Effort: small to medium.

### 4. Tags that join two people

`son_gohan` and `grandpa_gohan` both attach to Bangumi's one 孫悟飯: the second tag's Japanese name is 孫悟飯 with a qualifier, and no count sets them apart since both are `dragon_ball`. Wikidata's two items join the same way, so `Grandpa Gohan` can read as a name of the wrong person. Two items of one source on one Bangumi entry are a signal nothing uses yet: 51 characters and 461 works have two or more Wikidata items (2026-11-02), some rightly (All Might and Toshinori Yagi), some not (八神コウ with Aoba Suzukaze, 中須かすみ with Toshiaki Kasuga).

- Effort: small to medium.

### 5. One preferred name per language

Each layer marks its best name per entity and language with its rank among every layer's best (`names.pref`); the client marks it `preferred` and labels by it. Of a hand-corrected table of ttheme's 41 names, 18 match. A two-word tag's words now beat other sources, which fixes most of them and gives `Yor Briar` over `Yor Forger`. "Case Closed" is the official English title of 名探偵コナン in both Wikidata and AniDB, and "Detective Conan" a synonym in both, so no rule that follows the sources picks it; a family head's `en` is that one work's (`The Hyrule Fantasy`), so ttheme titles a franchise from its tag.

- Effort: small to medium.

### 6. Search ranking

Popularity is Bangumi's alone since the spine, so namesakes reorder: `sakura` puts 間桐桜 before 木之本桜 and `hina` 天野陽菜 before 空崎ヒナ, whom Danbooru draws far more. Averaging Bangumi's and Danbooru's log scales where both exist was tried on 2026-11-02: first hits rose by 17 of 4,617 probe queries (paired randomization test p = 0.12, MRR p = 0.20) and ttheme's Japanese queries from 154 to 158 of 162, and `사쿠라` fell to 佐倉杏子, so it was left out. `attack on titan` finds the entry Wikidata and AniDB gave that name (Season 3's), not the first season.

- Effort: small to medium.

## Guards

### 7. Floors in the audit follow the data

`mise run eval` reports, without counting them, which of ttheme's tags resolve (`tests/ttheme.tsv`, 139 of 139) and the homes of ttheme's commons (`tests/homes.tsv`, 140 right and none wrong). `mise run audit` holds the floors a release must clear: 95% of the tags, 130 right homes and at most 5 wrong, the leads of 17 casts (`tests/leads.tsv`) and 88% of the probe sample found first (90.0% on 2026-11-11, with the forms of a name and a work's title, which are nearly always found, in the sample). They are set just under today's figures, so a source's own drift may trip them; raise or lower them when one does, with what changed in the commit. `tests/probe.json` was redrawn for the Bangumi ids, so probe figures before 2026-11-01 are on another sample.

- Effort: small each time.

## What a search costs

### 8. A deploy empties every client's cache

Chunk files are named by their contents and a client keeps them forever, yet none of the 15,483 files of the 11-03 site was still named by the 11-10 one, so every weekly deploy starts every cache cold. A cold search against the live site took about a second on 2026-11-11 (median of ten queries, 10 to 89 files in one to three rounds), nearly all of it the network: the same searches take 19 ms from local files. Measured on 2026-11-11 by cutting three releases again:

- 11-07 to 11-10, the same Bangumi dump: 99.9% of the key rows are the same, numbers included, but only 35% of the files are (5,398 of 15,527), nearly all of them `entity` files, because a cut that moves when a row comes or goes moves every later cut of its table. Cuts placed by the key alone could keep 71%.
- 11-03 to 11-07, a new dump, which is what a week is: 838 entities came and 15 went, so 69% of the kept ones changed number, and 11% of the key rows changed their popularity or standing. With numbers and cuts that never move, 4 of the 7,382 key files could survive and 2,093 of the 8,111 `entity` files.

So neither stable entity numbers nor stable cuts are worth their cost while a key row carries its entity's popularity. Taking it out is not enough either: over the same week, key rows without popularity are 99.85% the same, and with numbers and cuts that never move 10% of the key files of about 1,000 rows could survive, 49% at 250 rows a file and 72% at 100; without the adult and layer flags too, 17%, 57% and 77%. That is format 2, four times the files, a manifest in two levels and the popularity read from elsewhere, for half the key files of a client that repeats its searches. Left; what a cold search reads was cut instead (9).

- Effort: large.

### 9. What the first round does not see

Since 2026-11-11 a search ranks from the key rows of its first round (each carries its entity's family), and reads `entity` rows only to show cards; one engine ranks over the files and over SQLite. Against the 0.8 client on the probe sample (4,646 queries of the forms it had, 633 of a name with a work's title): 24 files for 39 and 242 KB for 332 per cold query, results after one round for 83% of the queries (27%), the entity first 4,093 times for 4,084 and 618 for 555. What that left:

- A family's work is lifted only when the query finds it by a name, at its start, as one of its words, or at its end in Han or kana. One whose name holds the query elsewhere (`Shana OVA` in a longer title, `cuckoo` in `cuckoos`) is no longer lifted: 96.6% of the family that holds the query is in the first ten, for 99.6%. An ending lookup for every script recovered half of it (98.1%) for 57 KB more per search, so it was kept to the scripts that have no words.
- A two-word name with a typo can be read as a name and a work's title when some work starts with the mistyped word: 5 of 186 such names (`Rikka nohana`), since typos are looked for only when nothing matches.
- A Japanese given name with a title (`ひとり ぼっち`) finds nobody when the full name has no space: the ending match (58) is under what a scoped name needs (80).
- `Index` works out every entity's number, popularity and family when it opens, about 4 s on the 11-03 build, so `mise run search` waits that long; the build could store them.
- The family numbers cost 22 MB of the 162 MB site.

- Effort: small to medium each.

## Order

As a consumer needs them.
