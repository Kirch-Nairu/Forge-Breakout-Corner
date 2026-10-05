QUESTION_BANK = [
    {"id":"product.problem","domain":"PRODUCT","question":"What concrete problem must this product solve first?","kind":"text","required":True,"priority":100},
    {"id":"product.primary_user","domain":"PRODUCT","question":"Who is the primary user group?","kind":"text","required":True,"priority":99},
    {"id":"product.success","domain":"PRODUCT","question":"What measurable outcome means the first release succeeded?","kind":"text","required":True,"priority":98},
    {"id":"product.scope","domain":"PRODUCT","question":"What must be inside the first release?","kind":"text","required":True,"priority":97},
    {"id":"product.non_goals","domain":"PRODUCT","question":"What is explicitly out of scope for the first release?","kind":"text","required":True,"priority":96},
    {"id":"product.surface","domain":"PRODUCT","question":"What is the primary delivery surface?","kind":"single","options":["web_app","desktop_app","mobile_app","api_service","mixed"],"required":True,"priority":95},

    {"id":"users.roles","domain":"USERS","question":"How many materially different user roles exist?","kind":"single","options":["one","two_to_four","five_plus","public_plus_staff"],"required":True,"priority":94},
    {"id":"users.role_matrix","domain":"USERS","question":"Describe each role and what it must be allowed to do.","kind":"text","required":True,"priority":93,"when":[["users.roles","!=","one"]]},
    {"id":"users.external","domain":"USERS","question":"Will external users or customers sign in?","kind":"boolean","required":True,"priority":92},
    {"id":"users.admin","domain":"USERS","question":"Does the system need privileged administrators?","kind":"boolean","required":True,"priority":91},

    {"id":"workflow.core","domain":"WORKFLOW","question":"Describe the single most important end-to-end workflow from start to finish.","kind":"text","required":True,"priority":90},
    {"id":"workflow.states","domain":"WORKFLOW","question":"Does the core record move through named states or statuses?","kind":"boolean","required":True,"priority":89},
    {"id":"workflow.state_list","domain":"WORKFLOW","question":"List the states and allowed transitions.","kind":"text","required":True,"priority":88,"when":[["workflow.states","==",True]]},
    {"id":"workflow.approval","domain":"WORKFLOW","question":"Does any action require approval by another role?","kind":"boolean","required":True,"priority":87},
    {"id":"workflow.approval_rules","domain":"WORKFLOW","question":"Who can request, approve, reject, cancel, and reopen?","kind":"text","required":True,"priority":86,"when":[["workflow.approval","==",True]]},
    {"id":"workflow.bulk","domain":"WORKFLOW","question":"Are bulk actions required?","kind":"boolean","required":False,"priority":60},
    {"id":"workflow.sla","domain":"WORKFLOW","question":"Are deadlines, SLAs, escalation timers, or overdue states required?","kind":"boolean","required":False,"priority":59},
    {"id":"workflow.sla_rules","domain":"WORKFLOW","question":"Define the timing and escalation rules.","kind":"text","required":False,"priority":58,"when":[["workflow.sla","==",True]]},

    {"id":"data.entities","domain":"DATA","question":"What are the core entities or records the product must store?","kind":"text","required":True,"priority":85},
    {"id":"data.relationships","domain":"DATA","question":"What important relationships exist between those entities?","kind":"text","required":True,"priority":84},
    {"id":"data.sensitivity","domain":"DATA","question":"What is the highest sensitivity of stored data?","kind":"single","options":["public","internal","confidential","regulated_or_highly_sensitive"],"required":True,"priority":83},
    {"id":"data.files","domain":"DATA","question":"Will users upload or download files?","kind":"boolean","required":True,"priority":82},
    {"id":"data.file_rules","domain":"DATA","question":"What file types, size limits, retention, scanning, and download rules are required?","kind":"text","required":True,"priority":81,"when":[["data.files","==",True]]},
    {"id":"data.retention","domain":"DATA","question":"Are there retention, deletion, archival, or legal-hold rules?","kind":"boolean","required":True,"priority":80},
    {"id":"data.retention_rules","domain":"DATA","question":"Describe retention, archival, restore, and deletion rules.","kind":"text","required":True,"priority":79,"when":[["data.retention","==",True]]},
    {"id":"data.import_export","domain":"DATA","question":"Does the product need import or export?","kind":"single","options":["none","import_only","export_only","both"],"required":False,"priority":55},

    {"id":"ux.navigation","domain":"UX","question":"Which navigation model best fits the product?","kind":"single","options":["sidebar","top_nav","dashboard_first","task_queue_first","wizard_first","unknown"],"required":True,"priority":78},
    {"id":"ux.density","domain":"UX","question":"How information-dense should the main working screens be?","kind":"single","options":["low","balanced","high","very_high"],"required":True,"priority":77},
    {"id":"ux.mobile","domain":"UX","question":"What mobile requirement applies?","kind":"single","options":["desktop_only","responsive_basic","mobile_first","full_mobile_workflows"],"required":True,"priority":76},
    {"id":"ux.accessibility","domain":"UX","question":"What accessibility target should the implementation meet?","kind":"single","options":["reasonable_defaults","wcag_aa","wcag_aaa_where_practical","organization_specific"],"required":True,"priority":75},
    {"id":"ux.empty_error","domain":"UX","question":"Describe critical empty, loading, offline, and error states that must be understandable to users.","kind":"text","required":False,"priority":54},
    {"id":"ux.visual","domain":"UX","question":"Describe the visual direction, tone, or design system constraints.","kind":"text","required":False,"priority":53},

    {"id":"integration.external","domain":"INTEGRATION","question":"Does the product integrate with external systems or APIs?","kind":"boolean","required":True,"priority":74},
    {"id":"integration.list","domain":"INTEGRATION","question":"List each integration, direction of data flow, and failure expectation.","kind":"text","required":True,"priority":73,"when":[["integration.external","==",True]]},
    {"id":"integration.email","domain":"INTEGRATION","question":"Does it send email, SMS, push, or other notifications?","kind":"boolean","required":False,"priority":52},
    {"id":"integration.realtime","domain":"INTEGRATION","question":"Is realtime or near-realtime synchronization required?","kind":"boolean","required":False,"priority":51},

    {"id":"security.authn","domain":"SECURITY","question":"What authentication model is required?","kind":"single","options":["none","local_accounts","oidc_oauth_sso","directory_enterprise","unknown"],"required":True,"priority":72},
    {"id":"security.authz","domain":"SECURITY","question":"What authorization model is required?","kind":"single","options":["none","simple_roles","rbac","attribute_or_policy_based","mixed"],"required":True,"priority":71},
    {"id":"security.audit","domain":"SECURITY","question":"Must important actions be recorded in an audit trail?","kind":"boolean","required":True,"priority":70},
    {"id":"security.audit_events","domain":"SECURITY","question":"Which events must be immutable or attributable to a user?","kind":"text","required":True,"priority":69,"when":[["security.audit","==",True]]},
    {"id":"security.destructive","domain":"SECURITY","question":"Can users perform destructive or irreversible actions?","kind":"boolean","required":True,"priority":68},
    {"id":"security.destructive_rules","domain":"SECURITY","question":"What confirmation, authorization, soft-delete, or recovery behavior is required?","kind":"text","required":True,"priority":67,"when":[["security.destructive","==",True]]},
    {"id":"security.threats","domain":"SECURITY","question":"Name the highest-risk abuse cases or security failures you want explicitly defended against.","kind":"text","required":False,"priority":50},

    {"id":"architecture.preference","domain":"ARCHITECTURE","question":"Are there required technologies or architecture constraints?","kind":"text","required":True,"priority":66},
    {"id":"architecture.database","domain":"ARCHITECTURE","question":"What persistence direction is preferred?","kind":"single","options":["relational","document_json","embedded_sqlite","existing_database","unknown"],"required":True,"priority":65},
    {"id":"architecture.scale","domain":"ARCHITECTURE","question":"What initial scale should the design safely handle?","kind":"single","options":["single_team","department","organization","public_high_traffic","unknown"],"required":True,"priority":64},
    {"id":"architecture.offline","domain":"ARCHITECTURE","question":"Must any workflow continue while disconnected from the network?","kind":"boolean","required":False,"priority":49},
    {"id":"architecture.migration","domain":"ARCHITECTURE","question":"Is this replacing or migrating an existing system?","kind":"boolean","required":True,"priority":63},
    {"id":"architecture.migration_rules","domain":"ARCHITECTURE","question":"Describe existing data, compatibility constraints, cutover, and rollback expectations.","kind":"text","required":True,"priority":62,"when":[["architecture.migration","==",True]]},

    {"id":"quality.acceptance","domain":"QUALITY","question":"What must be demonstrably true before you accept the product?","kind":"text","required":True,"priority":61},
    {"id":"quality.browser","domain":"QUALITY","question":"Which browsers and viewport classes must be validated?","kind":"text","required":True,"priority":57},
    {"id":"quality.performance","domain":"QUALITY","question":"Are there explicit performance or latency targets?","kind":"boolean","required":False,"priority":48},
    {"id":"quality.performance_targets","domain":"QUALITY","question":"State the measurable performance targets.","kind":"text","required":False,"priority":47,"when":[["quality.performance","==",True]]},
    {"id":"quality.negative","domain":"QUALITY","question":"Which forbidden, unauthorized, malformed, or failure-path behaviors must be tested?","kind":"text","required":True,"priority":56},

    {"id":"deployment.environment","domain":"DEPLOYMENT","question":"Where should the first usable deployment run?","kind":"single","options":["local_machine","on_prem_server","vps_cloud_vm","managed_cloud","container_platform","unknown"],"required":True,"priority":46},
    {"id":"deployment.os","domain":"DEPLOYMENT","question":"What operating systems must deployment support?","kind":"text","required":True,"priority":45},
    {"id":"deployment.container","domain":"DEPLOYMENT","question":"Should containerization be part of the first release?","kind":"boolean","required":False,"priority":44},
    {"id":"deployment.release","domain":"DEPLOYMENT","question":"Who is allowed to approve and perform release or production deployment?","kind":"text","required":True,"priority":43},

    {"id":"operations.observability","domain":"OPERATIONS","question":"What must operators be able to observe when the system is healthy or failing?","kind":"text","required":True,"priority":42},
    {"id":"operations.backup","domain":"OPERATIONS","question":"Does persistent data require backup and restore?","kind":"boolean","required":True,"priority":41},
    {"id":"operations.rpo_rto","domain":"OPERATIONS","question":"What recovery-point and recovery-time expectations apply?","kind":"text","required":True,"priority":40,"when":[["operations.backup","==",True]]},
    {"id":"operations.maintenance","domain":"OPERATIONS","question":"Who will maintain the system and what maintenance tasks must be easy?","kind":"text","required":True,"priority":39},
    {"id":"operations.secrets","domain":"OPERATIONS","question":"How should secrets and environment-specific configuration be supplied?","kind":"text","required":False,"priority":38},

    {"id":"delivery.source_repo","domain":"DELIVERY","question":"Is Codex building inside an existing repository or creating a new one?","kind":"single","options":["existing_repository","new_repository"],"required":True,"priority":37},
    {"id":"delivery.protected_scope","domain":"DELIVERY","question":"What files, modules, services, or behaviors must Codex not change?","kind":"text","required":True,"priority":36,"when":[["delivery.source_repo","==","existing_repository"]]},
    {"id":"delivery.branching","domain":"DELIVERY","question":"What branch or candidate workflow should Codex follow?","kind":"text","required":True,"priority":35},
    {"id":"delivery.done","domain":"DELIVERY","question":"What exact evidence should Codex return when implementation is ready for review?","kind":"text","required":True,"priority":34}
]

CRITICAL_DOMAINS = ["PRODUCT","USERS","WORKFLOW","DATA","UX","SECURITY","ARCHITECTURE","QUALITY","DEPLOYMENT","OPERATIONS","DELIVERY"]
