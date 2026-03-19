# When SQL Stops Being for Humans: Rethinking the Modern Data Stack

The modern data stack solved a real problem — but it solved it for a world where humans were the bottleneck.

dbt and templated SQL became the default because the people who most urgently needed analytics (marketing ops, finance ops) were *code-constrained*. They needed to reconcile Stripe revenue, track spend, compute churn, and answer operational questions without pulling engineers off core product work. SQL won because it was the lowest-friction interface that a semi-technical operator could reliably use. dbt won because it added just enough software engineering discipline (version control, modularity, reuse) without forcing those operators to leave SQL.

That history matters because the constraint that produced today’s stack is changing. If the “operator” of analytics becomes a coding agent, we should be willing to re-test the default architecture — not by arguing about taste, but by building existence proofs and measuring what happens.

This post introduces a benchmark + RL gym environment I built to do exactly that.

---

## The modern data stack was an organizational workaround

There’s a common story that the modern data stack emerged from better databases and cloud warehouses. That’s true, but incomplete.

The deeper story is organizational:

- Operational teams needed answers fast (marketing efficiency, revenue reconciliation, finance reporting).
- Engineering time was scarce and prioritized for product.
- The people doing analysis were often “half analyst, half operator” (marketer/accountant/ops) — not software engineers.
- SQL became the interface because it’s direct, inspectable, and works with the shape of warehouse data.

dbt is the natural endpoint of that path: keep SQL as the interface, but add structure so a growing pile of queries doesn’t collapse under its own weight.

This is not a criticism. It’s a description of how standards form: not purely by “bestness,” but by path dependence. The thing becomes the thing because everyone already knows the thing.

---

## The split-brain problem: production truth vs warehouse truth

The modern data stack also bakes in a structural split:

- The *true* source of truth for customers, states, business rules, entitlements, and lifecycle logic lives in the production application and its database.
- The warehouse holds a derived, lagging, reshaped copy of that truth — plus third-party truth (Stripe, ads, CRM) that often lives *only* in the warehouse.

The result is that the most important questions require reconciliation across domains that don’t share a single authoritative model. You end up joining production-derived entities with third-party events, stitching them together with constrained logic, and encoding meaning in SQL transformations.

That pattern persists because it works — but it’s also an artifact of the original constraint: it’s a way to let non-engineers operationalize analysis without asking them to build and maintain application-grade models.

---

## The “why now”: dbt’s core advantage is dissolving

Here’s the crux:

**dbt is the optimal tool for code-constrained humans.**

But what if the operator is not a human analyst reading and writing SQL?

If agents can write code freely, then “SQL is the easiest interface for humans” stops being the primary design constraint. The relevant question becomes:

> For an agent trying to answer business questions, which representation of the system is the most legible, robust, and correct?

That’s not a philosophical question. It’s a benchmarkable one.

So I built a benchmark.

---

## The benchmark: same questions, different representations

I wanted to test a simple hypothesis:

> If you give a model a realistic analytics task, does it perform better when analytics lives in an app-native, typed codebase — or when it must work through a dbt-style SQL environment?

To isolate representation (not scale), I chose:

- Small data (so performance/compute doesn’t dominate)
- Questions with known answers (so evaluation is unambiguous)
- A consistent schema story across environments

### The three environments

1) **TypeScript sandbox (app-native, typed)**
- The model writes TypeScript to compute metrics directly.
- The goal is to see what happens when it has full expressive power and types.

2) **ORM sandbox (Drizzle)**
- Same idea (app-native), but mediated through ORM abstractions.
- The model must modify/extend an existing Drizzle setup to answer analytical questions.

3) **dbt-style environment**
- Raw SQL + templating + dbt project structure.
- The model answers by writing or editing dbt models.

### The three tasks (initial set)

- ARPU  
- churn  
- LTV

These are not “hard” tasks in an abstract sense. They’re intentionally canonical. The test is not whether the question is clever; it’s whether the environment makes it easy to be correct.

---

## Early signal: representation matters

So far, this is the direction of travel:

- In app-native environments (TypeScript / ORM), mid-tier models can often get to correct answers quickly.
- In the dbt environment, models tend to struggle more — not because the math is harder, but because they get trapped in the constraints of SQL templating, indirect references, and transformation graphs.

One surprising pattern: for frontier models the initial task set is too easy — they brute-force it. For mid-tier models, the environment becomes decisive: the same question becomes materially harder depending on how much indirection and brittle transformation logic they have to traverse.

I’ll share detailed results and failure modes in the next post, along with the baseline agents and evaluation harness.

---

## Why an RL gym: turning architecture debates into existence proofs

There’s a lot of hand-wavy discourse right now about “context layers,” “context graphs,” “semantic layers,” and “AI-native analytics stacks.”

Some of these ideas may be real. Some may be vibes.

My bias is simple:

> If you can’t demonstrate a simple instance of a complex idea, it doesn’t exist yet.

An RL gym gives you a way to operationalize that:

- Define an environment with clear interfaces and constraints.
- Define tasks with objective scoring.
- Run agents repeatedly.
- Measure success, error modes, and adaptation.

If a proposed “context architecture” is meaningfully different from a warehouse + dbt + semantic veneer, it should show up as measurable improvements in a controlled sandbox.

That’s the job of this benchmark: not to win arguments, but to force ideas to become runnable.

---

## What’s next

This post is the introduction: the history, the constraint shift, and the benchmark setup.

Next steps:

- Publish the benchmark + environments + baselines (so others can reproduce results).
- Increase task difficulty (multi-step reconciliation, schema evolution, late-arriving data, backfills, ambiguous definitions).
- Add new sandboxes representing “context graph” and “semantic layer” claims, and test them head-to-head against dbt and app-native baselines.

If you’ve got failure cases you think matter — especially messy real-world ones (changing definitions, edge-case revenue flows, partial identities, multi-system joins) — I’d love to include them as tasks. The benchmark is only as good as the tasks it forces agents to survive.

---

## TL;DR

- The modern data stack (and dbt in particular) is a rational response to a world where analysts were code-constrained.
- If LLM agents weaken that constraint, the default architecture deserves to be re-tested.
- I built a benchmark + RL gym to compare dbt-style SQL environments against app-native, typed alternatives.
- Early results suggest representation and constraints matter more than people assume — especially for non-frontier models.
- The goal is existence proofs: runnable sandboxes that make “context layer” claims measurable.


