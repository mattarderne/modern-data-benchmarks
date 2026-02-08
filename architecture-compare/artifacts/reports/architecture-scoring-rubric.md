# Scoring Rubric (Supplemental to Pass/Fail)

Goal: add partial credit signals without changing the outcome-based pass/fail scoring.

## Categories (Equal Weight)

Runtime correctness (0 or 1)
- 1 if the validator executes successfully and returns a numeric result.
- 0 if validation fails due to runtime error, missing file, or max-turn exhaustion.

Output correctness (0 or 1)
- 1 if the numeric result is within task tolerance.
- 0 otherwise.

Schema adherence (0 or 1)
- 1 if no schema-related errors were detected.
- 0 if error text indicates missing tables/columns or invalid identifiers.

Tool usage quality (0 to 1)
- Fraction of context files read by the agent.
- Uses sandbox `contextFiles` as the reference set.

## Total Score

Total rubric score is the simple average of the four categories.

Notes
- This rubric is computed for reporting only; pass/fail remains outcome-based.
- Schema adherence is heuristic based on error text and should be reviewed for false positives.
