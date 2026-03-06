# Blog v2 — Notes & References

## Semantic layer critique

[Stop Trying to Make Semantic Layer Happen](https://jaysobel.substack.com/p/stop-trying-to-make-semantic-layer) — Jay Sobel

Argues semantic layers are unnecessary overhead. Key claims:

- Data warehouses are high-dimensional spaces — comprehensive semantic mapping is tedious and impractical
- Modern LLMs make the original problem (machine-readable metadata) moot — prose descriptions work better
- The fix is simpler: **name things well, write paragraphs of documentation, use SQL directly**
- Three things worth keeping from the semantic layer idea: formal table relationships, higher-order schema docs, metric definition storage

Relevant to our benchmark because:
- Our dbt-documented experiment showed the same thing from the other direction — adding comprehensive schema.yml docs to the warehouse sandbox did NOT significantly close the performance gap vs typed codebases
- Sobel's argument that "just write paragraphs" is the answer lands differently when you have data showing that even with good docs, the architecture is the bottleneck
- His point about LLMs rendering machine-readable metadata moot aligns with our finding that types + co-location > metadata + indirection
- Supports the "scaffolding is the tell" argument from the blog: you can keep adding layers (semantic YAML, docs, naming conventions) to SQL, and at some point you're converging on what you'd build if you started with types


## tweet notes

https://x.com/mattarderne/status/2014598022454214701
Context Wars

It’s the Robot Wars for context engineers. 

Each team builds their own context management system, and gets dropped into a variety of zero sum simulation environments where there can be only one winner. 

Round 1: AI-SDR. Who has the best follow up game. Your agent will be battling a high volume sales frenzy, where arbitrary details sequence details make all the difference. How legible is your temporal resolution 

Round 2: Customer Super Success. More volume games, the customers are pissed! Can you triage and avoid a viral customer blowup by sourcing the right information at the right time? 

Round 3: Loan underwriting. More asymmetry to the downside. You are competing for low volume high value commercial loans, but remember, it’s the loans you do make that bite, not the deals that you miss. 

Round 4: Venture capital. How well does your context deal with vibes. Being contrarian and right means you need to feel it in your context guts. Conviction amirite

https://x.com/mitsuhiko/status/2020796129303032020
https://lucumr.pocoo.org/2026/2/9/a-language-for-agents/
Last year I first started thinking about what the future of programming languages might look like now that agentic engineering is a growing thing. Initially I felt that the enormous corpus of pre-existing code would cement existing languages in place but now I’m starting to think the opposite is true. Here I want to outline my thinking on why we are going to see more new programming languages and why there is quite a bit of space for interesting innovation. And just in case someone wants to start building one, here are some of my thoughts on what we should aim for!

https://motherduck.com/blog/bird-bench-and-data-models/

Good data modeling is the semantic layer. When your tables are well-named and your joins are straightforward, the LLM has everything it needs. There's a growing ecosystem of tools promising to make your data "AI-ready" through context layers and metadata platforms. Some of that will matter for genuinely complex domains. But for most orgs? Clean up your data model. That's the highest-ROI investment you can make.

https://substack.com/home/post/p-174498909
Most companies have 1,000s of tables, several with 100+ columns, and these tables are inter-related.

Bringing a Semantic Layer to this high dimensional manifold is like bringing a label printer to a jungle. Now start by labeling each thing in the jungle. Then label the relationships between the things, and finally label all the interactions you might have with a thing or a relationship.

How should an LLM interface with data?

The answer is: whatever way has the deepest distribution in the training corpus.

So actually the answer is Python + Pandas. But SQL is a solid option, easy to implement, and easier to reason about for the rest of the data team.

It’s actually kind of tragic that LLMs aren’t better at SQL given its age; SQL is older than Bash. What matters for LLMs is the prevalence of the language in the corpus of ‘the public internet’, and here SQL has several issues; it comes in many dialects, it has often omitted state in the database tables it references, and hidden semantics as well. There’s just not as much SQL as there is “Data Science Python”.

But you know what there’s even less of? Proprietary semantic layer APIs that have yet to be written. Just switching between SQL and one of these APIs probably nerfs your model’s IQ by a dozen points.

https://www.dataproductdriver.com/p/the-decline-of-data-organizations

However, many newer organizations never build a separate BI or central data team. Instead, product and business leaders who get data work run the core platform from day one (usually under Engineering or the CTO)

