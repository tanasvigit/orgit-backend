# Entity Master Template: OrgIt Master Bulk

Single source of truth for the unified **OrgIt Master Bulk** Excel workbook: sheet order, column names, and mapping to database/API.

- **Workbook name:** OrgIt Master Bulk
- **Download filename:** `OrgIt_Master_Bulk.xlsx`
- **Download / upload:** Settings only (`GET /api/admin/entity-master/template` with no query params)

Partial templates (`?only=organisation-structure`, `?only=employees`, etc.) and the standalone task template API are **deprecated**. Use the master workbook from Settings.

## Out of scope (web only)

| Data | Where to edit |
|------|----------------|
| Organisation legal profile (GST, registered address, constitution) | Admin → Entity Master |
| Employee module access, task/document permission matrices | Admin → Employees (edit user) |
| Password for new users | Add-user flow on web |

## Breaking changes (legacy templates)

Uploads containing these fail with an explicit error:

- **Sheets:** Cost Centres, Branches, Depot, Depots, Warehouse, Warehouses, Client Entity Services
- **Client List columns:** Cost Centre, Depot, Warehouse, Org Unit Name (use per-level columns)
- **Structure Reference** sheet (removed) — use **Org Node Lookups**

Legacy sheet name **Entity List** is still accepted on upload; the template uses **Client List**.

## Sheet order

1. **Instructions** – fill order (not imported)
2. **Organisation Structure** – hierarchy nodes (`organization_structure_nodes`)
3. **Org Node Lookups** – dropdown source (formula-driven; not imported)
4. **Service List** – `task_services`
5. **Client List** – `client_entities` + compliance matrix
6. **Employees** – users + `user_organizations`
7. **Tasks** – bulk task create

**Recommended fill order:** Organisation Structure → Service List → Client List → Employees → Tasks.

After adding Structure rows, save the file or press F9 so Excel recalculates **Org Node Lookups** and Client/Employee org dropdowns (Excel 365 `FILTER`/`UNIQUE` over table `OrgStructureNodes`).

---

## Sheet: Organisation Structure

Fixed columns (in order):

| Column | Required | Notes |
|--------|----------|--------|
| Section | Yes | Dropdown: Group, Entity, Department, … |
| Field Type | No | Section-dependent dropdown (validated on upload) |
| Field Name | Yes | Stored as `organization_structure_nodes.name` |
| Short Code | No | Stored as `code` |
| Parent Name | Root only blank | Dropdown from Org Node Lookups; parent rows before children |
| Display Label | Auto (formula) | Same format as web dropdowns: `Name (Type)` when type ≠ section |
| *{Dynamic fields}* | Per schema | Address, PAN, etc. — keys in `meta_json.fieldValues` |

**Legacy headers** accepted one release: `SECTION`, `ENTITY_TYPE`, `PARENT_NAME`, `Name`.

Excel table name: `OrgStructureNodes`.

---

## Sheet: Org Node Lookups

One column per active org section (L2+). Pre-seeded from existing DB nodes; appended rows use `UNIQUE(FILTER(OrgStructureNodes[Display Label], …))` so new Structure rows appear in dropdowns after recalc.

Client List and Employees section columns validate against `'Org Node Lookups'!$Col$2:$Col$5000`.

---

## Sheet: Service List

| Column | Notes |
|--------|--------|
| RECURRING TASK TITLE/SERVICE LIST | Recurring service title |
| FREQUENCY | Dropdown |
| TASK ROLL OUT | End of Period / 1 Month Before Period End |
| ONE TIME TASK LIST | One-time service title |

---

## Sheet: Client List

| Column | Maps to |
|--------|---------|
| NAME OF THE CLIENT | name |
| ENTITY TYPE | entity_type |
| STATUS | status |
| *{Level labels}* | `org_field_values.orgNodeByLevel` — dropdown from Lookups |
| ORG STRUCTURE NODE ID | Optional `org_structure_node_id` override |
| PAN | pan |
| REPORTING PARTNER | reporting_partner_mobile |
| *{Service titles}* | `client_entity_services.frequency` |

---

## Sheet: Employees

Aligns with the Add Employee web form (HR + org mapping). Permission matrices are **not** in Excel.

| Column | Maps to |
|--------|---------|
| EMPLOYEE ID | employee_code |
| NAME OF THE EMPLOYEE | users.name |
| MOBILE NUMBER | users.mobile |
| EMAIL ID | email |
| DOB | date_of_birth |
| GENDER | gender |
| ADDRESS | address |
| PAN NUMBER | pan_number |
| DATE OF JOINING | date_of_joining |
| EMPLOYMENT TYPE | employment_type |
| EMPLOYEE STATUS | status |
| DESIGNATION | designation |
| REPORTING TO | reporting_to_mobile |
| WORK LOCATION | work_location (resolved to org node) |
| *{Level labels}* | `org_field_values.orgNodeByLevel` |
| SECONDARY ORG UNITS | secondary org assignments |
| USER ROLE | user role |
| ORG STRUCTURE NODE ID | Optional `primary_org_node_id` override |

---

## Sheet: Tasks

Same columns as the former standalone task template. Processed by `taskBulkService.parseAndApply` on full upload.

---

## API

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/admin/entity-master/template` | Master workbook only |
| POST | `/api/admin/entity-master/upload` | Full or single-sheet upload |
| GET | `/api/admin/entity-master/status/:uploadId` | Poll progress |

Task-only template: `GET /api/admin/tasks/bulk/template` returns **400** with redirect message to Settings.

Import order in worker: Structure → Service List → Client List → Employees → Tasks.
