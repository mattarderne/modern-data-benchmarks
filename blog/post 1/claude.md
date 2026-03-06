# Benchmarking the Modern Data Stack Against What an LLM Would Build From Scratch

The modern data stack exists because marketing ops and FinOps teams were massively code-constrained. That constraint shaped everything: the tools, the architecture, the conventions. Now that the constraint is lifting, I wanted to test whether the architecture still makes sense. So I built an RL gym to find out.

[Link to original post on the history of the modern data stack]

## How we got here

The modern data stack came out of a need to operationalise non-core functions at fast-growing companies. Marketing needs to track ad spend conversion. Finance needs to reconcile Stripe against users, handle VAT, run revenue recognition. These are important, but they're not core: a company like Uber isn't going to assign its best engineers to marketing attribution.

So what happens is a half-analyst, half-marketer (or half-analyst, half-accountant) ends up digging into the data directly. They can't write Python, but they can write SQL. SQL is easy, it's what-you-see-is-what-you-get, and it lets non-engineers explore data in a way that actually works. The analyst writes queries against a data warehouse, things get messy, and eventually someone introduces dbt to bring version control and templating to the chaos. Macros and functions dropped into SQL gave real value to humans writing these queries.

The point is: this entire stack exists because these teams could not write code. The gravity of that constraint pulled everything towards raw SQL against a data warehouse. No types, no abstractions, nothing but SQL.

If a software engineer built this system from first principles, this is not the system they would build.

## OpenAI's data warehouse smells like dbt

What surprised me recently was looking at OpenAI's data warehouse architecture. On the surface it looked sophisticated: context layers, embeddings, all the works. But at the core, two things stood out.

First, it was driven by FinOps. The canonical example was revenue reconciliation from Stripe to their monolith app. This wasn't surprising in itself (it's the canonical use case for every finance team), but it confirmed that even at frontier AI companies, FinOps drives the data warehouse.

Second, the method gave a strong smell of dbt. And why wouldn't it? The team running the show had used dbt before. If you've used it before, you reach for it again. You don't reinvent the wheel.

This gave me a stronger suspicion that dbt is now a de facto standard. Not because anyone did a systematic evaluation and concluded it was optimal, but through pure path dependency. The thing becomes the thing because it was the thing, and that makes it more of the thing. Standards don't emerge from rationalisation; they emerge from repetition.

dbt is now the standard for analytics even more so if the poster child for new architecture includes raw SQL templating at its core.

## The problem: humans aren't reading the SQL any more

This matters because the original reason dbt existed was to make SQL manageable for human analysts. But at scale, there are now tens of thousands of lines of SQL that no human is ever going to read. The SQL is being consumed by AI. And I wondered what we're losing by continuing down this path without questioning it.

## The dual-system problem

Before getting to the experiment, it's worth spelling out the structural issue that the modern data stack creates.

Your monolith app has your core business logic: users, statuses, transactions. Then separately, you have a data warehouse. Every time a status changes in the app, it needs to be synchronised to the warehouse. One happens, then the other happens. You can automate this, but it's rarely seamless: it's two phased systems, a typed app and raw SQL, running in series with some delay.

Then you have third-party data like Stripe, which only exists in the data warehouse. Your monolith app doesn't know about it. If the app needs that data, it comes back via reverse ETL or API exposure: a kind of round-trip that nobody designed on purpose.

Over time, the data warehouse gets promoted to "single source of truth." Anyone who's worked in a data team will give that a big eye roll. The data warehouse is the source of confusion. It surfaces the business's confusion rather than brings any real truth. Your actual source of truth for customer status is the production database. The derived source is the warehouse. And when the source changes, there's a period where the warehouse is wrong. So the "single source of truth" is never truly trustworthy, which leads to a lot of back-and-forth and reconciliation overhead.

## The crux: what if you brought the data home?

The key friction point is this: Stripe data lives in the data warehouse and the main app doesn't know about it. To do anything useful, you need to join app data onto Stripe data inside the warehouse, using SQL, using coalesce, using very constrained logic. This works. But it's not what a superhuman coding system would build if given free reign to architect from first principles.

So the question becomes: what if you loaded Stripe data (or any third-party data) into a structure that your main app understands? Build an internal API for it, represent it with proper types and constraints, and run your analytics directly against the monolith? The storage layer matters less (could be a warehouse, could be a database): the point is treating it as your own data, not as a foreign system you have to reconcile with.

If revenue is a key business capability, and we're no longer as software-constrained as we were, why not model it as a first-class concept within the core app? Something with proper types, proper abstractions, no 15-minute reconciliation delay, that engineers and coding agents can access directly.

If the answer to that is yes, then the question is: what's the best way of doing it?

## The experiment

I built an RL gym with three sandbox environments, all given the same structure and data. The data is small (a random sample where we know the correct answers). The questions are straightforward: ARPU, churn, and LTV. The size of the data isn't the test. The architecture is.

The three environments:

- A raw TypeScript sandbox, where the LLM can write whatever code it wants to answer the questions
- A Drizzle ORM sandbox, where the LLM must use an ORM and can modify the schema to answer analytical questions
- A standard dbt environment, where the LLM works with SQL models in the usual way

In the TypeScript and Drizzle sandboxes, the Stripe-equivalent data is represented as internal data with types and APIs. In the dbt sandbox, it follows the traditional pattern: third-party data loaded into a warehouse and joined via SQL.

## Early results

[Insert experiment results here]

The bigger models handle all three environments fine: the questions aren't hard enough to differentiate. But at the mid-tier (models like Sonnet), differences start to appear. dbt struggles. The TypeScript and ORM environments seem to provide enough structure that mid-range models can reason about the data more effectively.

This is vibe-coded and early. But it's showing enough signal that there's merit to the thesis: for LLM-driven analytics, putting all the business logic and data in one typed repo may be more effective than forcing the model to traverse dbt logic and a monolith app separately.

## What's next: does the context layer exist?

I see a lot of hand-waving about the "context layer" and "context graph." I've criticised these concepts before because I think they're extremely vague. When you boil them down, they tend to resolve into something that looks a lot like a data warehouse, or a semantic layer, or something very familiar dressed up in new language.

My position is: if we can't demonstrate a simple instance of a complex idea, then the idea doesn't meaningfully exist. A good concept should have an existence proof: a simple version you can point at and say, that's it, that's the thing, and it's meaningfully distinct from what we already have.

My next step is to take the literature on context layers and context graphs, build sandboxes that represent what they're trying to prove, run them through the same RL gym, and see if they perform meaningfully differently from what I've set up here. Come up with the best-case examples for the context graph, implement them, and test them.

That's the best way to validate whether something is a genuinely new idea or just a repackaging of what we already know. Run it as an experiment and see what happens.
