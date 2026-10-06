# KIRION FORGE — GOOGLE AI STUDIO CODE_WRITER PASS 01

You are operating as an **external KIRION Forge CODE_WRITER worker**.

You are NOT the authority plane.

Your task is to convert the existing ONE TALIBON React/Vite functional prototype into the authoritative full-stack common core.

## Candidate identity

Treat the uploaded source as the audited candidate:

- Artifact: `kimi-main.zip`
- Artifact SHA-256: `384b568157ca7d3aa8f554350406d582716f5708bbb9d7745499dfcc72ed2efd`
- Extracted-tree manifest SHA-256: `5347d85b455ddb41bed8daa6e218b8e8d99fa648f52b21929b22e3383b39627d`
- Embedded Git-like source hint: `641b65c13722c884e800e2575a0490a30607bd15`
- IMPORTANT: that 40-character value was not independently proven as Git state because the ZIP did not include `.git`. Treat it only as an archive source hint. The SHA-256 artifact identity is the authoritative input identity for this worker run.

## Locked decisions

These are resolved. Do not ask again.

1. **Authentication:** ONE TALIBON local username/password with real TOTP MFA.
2. **Frontend:** Preserve the existing React/Vite frontend and place an authoritative Laravel JSON API underneath it.
3. **Session model:** same-origin Laravel Sanctum cookie/session authentication with CSRF protection. Do not use LocalStorage as an authentication or authorization authority.
4. **Database:** PostgreSQL 15+.
5. **Deployment target:** self-hosted Linux / Ubuntu-class server.
6. **Roster:** every existing office, employee, person, email, contact number, position and similar seed record is DEMO DATA until an LGU-authoritative roster is supplied. Even if a value was found on the public web, that does NOT make it approved production master data.
7. **Documents:** actual bytes must be stored in Laravel private filesystem storage with PostgreSQL metadata and authorization-gated download endpoints.

## Forge authority

You MAY:

- inspect the entire supplied candidate;
- change the candidate implementation;
- add a Laravel backend;
- add migrations, policies, controllers, services/actions, events, listeners, notifications, jobs, scheduler definitions, tests and deployment artifacts;
- rewire the React frontend to authoritative APIs;
- repair defects you discover;
- run available checks.

You MUST NOT:

- claim ACCEPTED;
- claim INTEGRATED;
- claim PROMOTED;
- claim DEPLOYED;
- claim PRODUCTION_ACCEPTED;
- invent official LGU workflow rules;
- invent official KPIs;
- invent official office/employee master data;
- call documentation evidence of runtime behavior;
- report PASS for a check that was not actually executed;
- hide unresolved authority gaps by hard-coding guesses.

Forge will independently audit your result.

---

# A. PRESERVE THE GOOD FRONTEND

The previous forensic audit classified the frontend as highly salvageable.

Preserve, unless a concrete implementation defect requires a bounded change:

- overall municipal visual language;
- application shell;
- sidebar/header/navigation IA;
- My Work;
- Tasks;
- Work Requests;
- Correspondence;
- Documents UI shell;
- Global Search interaction;
- Notifications UI;
- Calendar and Meetings;
- Announcements;
- Memoranda;
- Messaging;
- Directory;
- Workflow visualization;
- Reports;
- Security/Audit presentation;
- role dashboard layouts.

Do NOT redesign the whole product merely because a backend is being added.

The goal is:

```text
EXISTING UX
    ↓
API ADAPTERS
    ↓
LARAVEL AUTHORITATIVE DOMAIN
    ↓
POSTGRESQL
```

Remove or isolate from production:

- Persona Switcher;
- role preview that grants actual authority;
- LocalStorage authority;
- fake MFA;
- fake document upload/download/hash behavior;
- invented compliance labels;
- unsupported official-data wording.

A development-only role-preview tool may exist only if it cannot alter a real authenticated identity and is disabled by default outside an explicit development environment.

---

# B. BACKEND ARCHITECTURE

Add a Laravel application, preferably under:

```text
backend/
```

Preserve the current React app in place unless moving it is necessary for a clean build.

Use a versioned JSON API:

```text
/api/v1/...
```

Use:

- Laravel;
- PostgreSQL;
- Laravel Sanctum same-origin session/cookie auth;
- CSRF protection;
- Form Requests or equivalent server-side validation;
- Policies/Gates for object-level authorization;
- domain service/action classes for non-trivial business operations;
- database transactions for multi-row lifecycle mutations;
- database constraints for invariants that belong in persistence;
- Laravel Events/Listeners for authoritative domain events;
- Laravel Notifications for in-system notification generation and optional future email delivery;
- queue/jobs where work is asynchronous;
- scheduler for due-soon/overdue/escalation behavior.

Do not expose a generic arbitrary-command endpoint.

---

# C. AUTHENTICATION

Implement real local authentication.

Required:

- username or approved local login identifier;
- password;
- password hashing through Laravel's hashing facilities;
- inactive/suspended account enforcement;
- authenticated session;
- logout;
- session invalidation on deactivation where feasible;
- login throttling/rate limiting;
- password change;
- safe password reset foundation;
- CSRF protection;
- no user-controlled role/office identity.

Do not store plaintext passwords.

Do not trust user IDs, role IDs, office IDs or permission lists supplied by the React client.

---

# D. REAL TOTP MFA

Replace the current boolean/method flag with actual TOTP.

Implement:

- cryptographically random TOTP secret generation;
- enrollment flow;
- QR/otpauth provisioning URI if library support exists;
- verification before enabling MFA;
- encrypted-at-rest factor secret;
- login-time second-factor challenge;
- recovery codes;
- regeneration/revocation behavior;
- rate limiting for OTP attempts;
- audited MFA enable/disable/recovery events.

Use a maintained TOTP implementation/library appropriate to the installed Laravel version. Document the dependency and why it was selected.

A production user must never become "MFA active" merely by toggling a boolean.

---

# E. ORGANIZATION / ROLES / PERMISSIONS

Normalize authoritative tables/models for:

- offices;
- employees;
- users;
- roles;
- permissions;
- user-role relationships;
- role-permission relationships;
- office membership/assignment;
- account status;
- acting Department Head relationship where needed.

The current seed roster is DEMO DATA.

Label demo seed records accordingly.

Do not call the seed list the authoritative or official LGU roster.

Authorization must include both:

- capability/permission;
- object/office scope.

Use Laravel Policies/Gates at the authoritative read and mutation boundary.

---

# F. FIRST-CLASS TASK DOMAIN

Preserve the existing Task domain separation.

Implement authoritative:

- creation;
- assignment/reassignment;
- start;
- completion;
- reopen;
- cancellation;
- due date;
- priority;
- related entity;
- immutable event chronology.

Create an explicit state transition policy.

Reject invalid transitions server-side.

Validate that an assignee belongs to an allowed office/context.

Cancellation must not erase history.

Do not use array length or Date.now() as an authoritative reference generator.

Use database-safe unique identifiers/reference allocation.

---

# G. WORK REQUEST / INTER-OFFICE TRANSACTION

Preserve the good conceptual split between:

- origin office;
- current custodial office;
- person-level assignee.

Implement authoritative lifecycle actions:

- create;
- receive;
- assign;
- reassign;
- forward;
- return for correction;
- reroute where authorized;
- update/action;
- complete.

Every custody transfer must be transactional.

Every material transition must create an event.

Historical custody must never be overwritten.

Reject:

- forwarding by an office that does not hold custody;
- assignment to an invalid office/person;
- invalid state transitions;
- forged previous-office values.

Reference generation must be concurrency-safe.

---

# H. CORRESPONDENCE

Keep Correspondence separate from Work Requests.

Implement authoritative:

- intake;
- registration;
- classification;
- confidentiality;
- reference generation;
- routing;
- acknowledgement when configured;
- attachments/documents;
- linked Work Request behavior;
- archive state where authorized.

The current `TAL-COR-*` and other masks are DEVELOPMENT CONFIGURATION until approved.

Do not present them as final municipal policy.

Correspondence must be able to exist without a Work Request.

---

# I. DOCUMENTS / ATTACHMENTS / RECORDS

The current implementation is a showcase and must be replaced.

Implement actual file handling:

- multipart upload;
- private filesystem storage;
- original filename stored only as metadata;
- generated safe storage key;
- MIME validation;
- allowed extension policy;
- byte-size limit;
- filename/path traversal defense;
- SHA-256 calculated from actual bytes;
- database metadata;
- uploader;
- office context;
- confidentiality;
- linked domain entity;
- authorization-gated metadata lookup;
- authorization-gated streaming/download endpoint;
- delete/retention behavior that preserves audit requirements.

If malware scanning cannot be fully implemented in the environment, provide a clean hook/interface and mark it NOT EXECUTED rather than pretending.

Remove the fake random-size upload logic.

Remove "SHA-256 Verified" unless a real hash was computed.

Remove "National Archives Compliant" unless authoritative retention policy is supplied.

---

# J. GLOBAL SEARCH

Move search authority to Laravel/PostgreSQL.

Unauthorized rows must never be sent to the client merely to be filtered later.

Implement authorized server-side query scopes for:

- Tasks;
- Work Requests;
- Correspondence;
- Documents/Records;
- Memoranda;
- Meetings;
- Announcements.

Authorization must protect:

- results;
- counts;
- previews;
- autocomplete;
- direct object retrieval.

Preserve the existing search UX.

---

# K. AUDIT

Replace mutable LocalStorage audit data.

Create an append-only PostgreSQL audit model containing at least:

- actor;
- action;
- entity type;
- entity ID;
- outcome;
- timestamp;
- old state where appropriate;
- new state where appropriate;
- request/correlation ID;
- IP/user-agent when available.

Application users, including administrators, must not have an ordinary update/delete path for historical audit rows.

Use a database-level protection such as a trigger or appropriately restricted database role to reject UPDATE/DELETE.

Test the rejection.

Do not use the word "immutable" unless the real enforcement is operating and tested.

---

# L. NOTIFICATIONS / QUEUES / SCHEDULER

Make in-system notifications authoritative in PostgreSQL.

Generate them from domain events.

Implement scheduler behavior for at least:

- due soon;
- overdue;
- configured stage SLA checks where approved.

Email remains optional.

Do not require production SMTP credentials to run the core application.

Use an abstraction/configuration for email delivery.

If queue workers are required, document exact worker commands.

---

# M. CALENDAR / MEETINGS / ANNOUNCEMENTS / MEMORANDA / MESSAGING

Add authoritative persistence and authorization for the existing UI domains.

Meetings must remain distinct from Tasks.

Meeting action items may create/link Tasks.

Announcement publishing must be permission-gated.

Memorandum acknowledgement must be per recipient where used.

Messaging must enforce conversation membership server-side and store unread state per user.

Do not invent specialized LGU approval chains.

---

# N. WORKFLOW CONFIGURATION

The previous prototype displayed workflow configuration but the runtime engines ignored it.

Fix that architectural split.

Create versioned workflow definitions capable of representing:

- owning office;
- intake fields;
- checklists;
- allowed states;
- allowed actions;
- receiver;
- assigner;
- processor;
- reviewer;
- approver;
- routing;
- SLA;
- notifications;
- permissions;
- output/completion.

Important:

- UNAPPROVED workflows must not silently become production policy;
- running workflow instances must bind to a specific workflow-definition version;
- later edits to a definition must not retroactively corrupt active/history instances;
- common Task/Work Request lifecycle behavior may remain native code where appropriate, but configurable behavior must actually influence authoritative execution if the UI claims it does.

---

# O. DASHBOARDS / REPORTS

Keep the existing layouts.

Derive values from authoritative database queries.

Remove:

- hard-coded KPI values;
- fake operational rates;
- unsupported Vice Mayor-specific rules;
- anything labeled an official municipal KPI without authority.

Operational indicators are allowed if their derivation is explicit and reproducible.

Exports must be server-authorized and office/permission scoped.

---

# P. DEMO DATA RULE

The current candidate may contain office names, employees, emails, phone numbers, positions, addresses or other data that may have been generated or found on the public web.

Forge decision:

```text
PUBLICLY DISCOVERABLE != LGU-AUTHORITATIVE
```

Treat ALL current roster/master records as:

```text
NON-AUTHORITATIVE DEMO DATA
```

until a separately supplied LGU-approved roster establishes authority.

Do not remove useful demo data merely because it is unverified; label it clearly and keep production seeding separate.

---

# Q. BUSINESS AUTHORITY — DO NOT INVENT

Do not finalize or pretend authority for:

- Procurement/BAC lifecycle;
- Project Monitoring/RPMES official KPI definitions;
- municipal document numbering masks;
- department-specific SLAs;
- department-specific escalation matrices;
- final office/employee roster;
- official routing matrices;
- official departmental approval chains.

Provide extension/configuration boundaries and an unresolved-authority document.

---

# R. REQUIRED NEGATIVE TESTS

At minimum, add and execute where supported:

## Authentication

- invalid password rejected;
- inactive account rejected;
- deactivated user cannot continue using an active session;
- login throttling works;
- MFA-enabled user cannot complete login without valid TOTP;
- invalid/replayed TOTP rejected where the selected library supports replay protection;
- ordinary user cannot alter their role/office through API input.

## Authorization

- cross-office Task mutation denied;
- cross-office Task reassignment denied;
- Work Request mutation without custody denied;
- assignment to invalid office/person denied;
- unrelated Correspondence reroute denied;
- confidential Document metadata retrieval denied;
- direct Document download denied;
- unauthorized Search result/count/autocomplete excluded;
- ordinary user cannot create/change users/roles;
- ordinary user cannot publish global announcements;
- ordinary user cannot export municipality-wide data;
- audit UPDATE/DELETE denied.

## Integrity

- duplicate reference generation prevented under concurrent requests;
- invalid state transition rejected;
- Work Request forward/receive/custody history remains chronological;
- return/correction does not destroy prior events;
- failed multi-record lifecycle operation rolls back atomically.

## Persistence

- state survives backend restart;
- state is shared by two independent clients;
- clearing browser LocalStorage does not destroy authoritative data.

## Documents

- invalid MIME/extension rejected;
- oversize upload rejected;
- traversal-style filename does not escape storage;
- SHA-256 equals the uploaded bytes;
- unauthorized direct download rejected.

---

# S. REQUIRED POSITIVE TESTS

At minimum:

- valid login;
- TOTP enrollment and challenge;
- Task create/assign/start/complete;
- Work Request create/receive/assign/forward/return/complete;
- Correspondence register/classify/route;
- real Document upload and authorized download;
- authorized Global Search;
- notification creation from domain event;
- meeting action item -> Task linkage;
- announcement publishing by permitted role;
- memorandum acknowledgement;
- authorized messaging thread;
- dashboard derived query;
- workflow version binding.

---

# T. BROWSER / UX VALIDATION

If browser automation tooling exists, exercise the actual running frontend/backend.

Test at minimum:

- login;
- MFA;
- Dashboard;
- My Work;
- Tasks;
- Work Requests;
- Correspondence;
- Documents;
- Search;
- unauthorized page/object state;
- mobile/narrow navigation;
- keyboard navigation for primary flows.

If no browser automation exists, report:

```text
Browser ........ NOT EXECUTED
Responsive ..... UNVERIFIED
Accessibility .. UNVERIFIED
```

Do not infer PASS from CSS.

---

# U. POSTGRESQL / RECOVERY EVIDENCE

Actually run PostgreSQL migrations if the environment can run PostgreSQL.

If Docker is available, a local development compose stack is acceptable.

Create backup/restore documentation regardless.

But:

```text
BACKUP/RESTORE = PASS
```

is forbidden unless you actually:

1. produce a backup artifact;
2. restore into a clean database;
3. verify restored rows/integrity;
4. record commands/output.

Otherwise:

```text
Backup/Restore .... NOT EXECUTED
```

---

# V. DOCUMENTATION / OPERATIONS

Update/create:

- README;
- `.env.example`;
- Laravel configuration notes;
- PostgreSQL migration/startup instructions;
- queue worker command;
- scheduler/cron command;
- Nginx or reverse-proxy example;
- production build instructions;
- structured logging notes;
- health endpoint;
- backup/restore runbook;
- security notes;
- data dictionary;
- unresolved LGU authority list.

Secrets must not be committed.

---

# W. REQUIRED FORGE ARTIFACTS

Create:

```text
KIRION_WORKER_RESULT.json
docs/KIRION_IMPLEMENTATION_EVIDENCE.md
docs/KIRION_UNRESOLVED_AUTHORITY.md
```

If executable tooling permits, also create a SHA-256 manifest of the final candidate files.

The evidence document must distinguish:

- TESTED;
- OBSERVED;
- DURABLE;
- UNVERIFIED;
- NOT EXECUTED.

---

# X. FINAL WORKER RESULT

Your final textual response must end with a JSON object matching this shape:

```json
{
  "protocolVersion": "kirion-worker-v1",
  "episodeId": "one-talibon-authoritative-rebuild-pass-01",
  "status": "COMPLETE | COMPLETE_WITH_LIMITATIONS | BLOCKED | FAILED",
  "sourceSha": "641b65c13722c884e800e2575a0490a30607bd15",
  "summary": "...",
  "claims": [],
  "changedFiles": [],
  "checks": [
    {
      "name": "...",
      "status": "PASS | FAIL | NOT_EXECUTED | UNVERIFIED",
      "evidence": "..."
    }
  ],
  "unresolved": [],
  "candidate": {
    "repository": "",
    "branch": "",
    "sha": "",
    "artifactSha256": "",
    "treeManifestSha256": ""
  },
  "handoff": "Return candidate to KIRION Forge for independent review."
}
```

Do not include any of these in `claims`:

- ACCEPTED
- INTEGRATED
- PROMOTED
- DEPLOYED
- PRODUCTION_ACCEPTED

---

# EXECUTION DIRECTIVE

Do not answer with a plan and stop.

Inspect the current source.
Preserve the valuable UX.
Build the Laravel API.
Build PostgreSQL persistence.
Implement real local authentication.
Implement real TOTP MFA.
Rewire React.
Add tests.
Run what the environment actually supports.
Repair failures.
Produce exact evidence.
Return the candidate to Forge.

**END STATE: CANDIDATE READY FOR FORGE REVIEW — NOT SELF-ACCEPTED.**
