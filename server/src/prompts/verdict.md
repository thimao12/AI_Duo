Your last review had no valid verdict block. Do not re-run tests or read files, and do not edit anything. Reply with ONLY a fenced JSON block, exactly in this shape:
```json
{"verdict": "APPROVE" | "CHANGES_REQUESTED", "tests": "pass" | "fail" | "none", "issues": [{"severity": "high" | "medium" | "low", "file": "path", "description": "what is wrong and how to fix it"}]}
```
