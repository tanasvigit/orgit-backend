# Entity Master Template: OrgIt Settings

Single source of truth for the **OrgIt Settings** Excel template: workbook name, sheet order, column names, and their mapping to database/API.

- **Workbook name:** OrgIt Settings
- **Download filename:** `OrgIt_Settings_template.xlsx`

## Combined vs organisation-only

| Workbook | Sheets | Updates |
|----------|--------|--------|
| **OrgIt Settings** (`OrgIt_Settings_template.xlsx`) | Structure + assignments only | Hierarchy, clients, services, employees, tasks — **not** the `organizations` profile row |
| **Entity Master template** (`?only=organisation`, `Entity_Master_template.xlsx`) | Organisation profile sheet only | `organizations` (legal/contact master) |

If a file contains **Entity Master Data (Org)** together with Organisation Structure / Entity List / Service List / Tasks / Employees, upload is rejected with a clear error (organisation profile must be uploaded alone).

## Breaking changes (legacy templates)

The following are **no longer supported**. Uploads containing them fail with an explicit error:

- **Sheets:** Cost Centres, Branches, Depot, Depots, Warehouse, Warehouses, Client Entity Services
- **Entity List columns:** Cost Centre, Depot, Warehouse, Org Unit Name (use per-level columns instead)
- **Employees:** DESIGNATON, LEVEL, DEPARTMENT columns are ignored if present in old files
- **Structure Reference** sheet (removed) — use **Org Node Lookups** dropdowns instead of copying UUIDs

Download a fresh template from Settings or the relevant admin screen before bulk upload.

## Sheet order (full OrgIt Settings workbook)

1. **Instructions** – fill order and notes (not imported)
2. **Org Node Lookups** – dropdown source for Entity List / Employees (not imported)
3. **Organisation Structure** – hierarchy nodes with **web-matching** fields (`organization_structure_nodes`)
4. **Entity List** – client entities + compliance frequencies
5. **Service List** – task services (`task_services`)
6. **Tasks** – convenience sheet (processed by task bulk parser on full upload)
7. **Employees** – users + org assignments (`user_organizations`)

**Recommended fill order:** Organisation Structure → Service List → Entity List → Employees → Tasks (as needed).

---

## Organisation profile (organisation-only template)

Use **Admin → Entity Master → Download template** (`Entity_Master_template.xlsx`). Sheet: **Entity Master Data (Org)**.

Vertical layout: column A = labels, column B = values.

| Label | DB field | Required |
|-------|----------|----------|
| Name of the Organisation | name | Yes |
| Short Name /Trade Name/ Business Name | short_name | No |
| Phone Number | phone_number | No |
| E Mail ID | email | No |
| Web Site | website | No |
| Entity Type | org_constitution | No (dropdown) |
| Country | country_id (resolved by name) | No |
| State | state_id | No |
| City | city_id | No |
| Pin Code | pin_code | No |
| Address Line 1 | address_line1 | No |
| Address Line 2 | address_line2 | No |
| GST Number | gst | No |
| PAN of the Entity | pan | No |
| Registration Number of the Entity | cin | No |

Parser also accepts legacy vertical labels and horizontal layout with row 1 headers.

Upload this file **by itself** (no other assignment/structure sheets).

---

## Sheet: Instructions

Read-only guidance. Matches web flow: Org Definition first, then assignments. Organisation profile is edited in Admin → Entity Master, not this workbook.

---

## Sheet: Org Node Lookups

Read-only. One column per active org section (L2+). Each cell is a dropdown option in the same format as the web UI: `Name (EntityType)` when entity type differs from the section label.

Entity List and Employees section columns use Excel list validation pointing at this sheet. Users should **pick from dropdowns**, not paste node UUIDs.

---

## Sheet: Organisation Structure

Columns mirror the **web Org Definition node form** (dynamic per level from field schema).

| Column | Required | Notes |
|--------|----------|--------|
| LEVEL | Yes | Section label (e.g. Region) or level number 1–11 — dropdown from defined levels |
| PARENT_NAME | Yes for L2+ | Parent node **name** (same as shown in web / Lookups); blank for Group root |
| ENTITY_TYPE | No | Entity type for this level — dropdown; validated per level on upload |
| *{Dynamic fields}* | Per schema | e.g. Name, Code, Registered Name, address fields — same keys as `meta_json.fieldValues` on web |

Rows are processed in level order. Existing nodes match on `(level, parent, name)` and update `meta_json` (entityType + fieldValues) and `code` when provided.

---

## Sheet: Entity List

Fixed columns (in order):

| Column | Maps to |
|--------|---------|
| NAME OF THE CLIENT | name |
| ENTITY TYPE | entity_type |
| STATUS | status (Active / Inactive) |
| *{Level labels}* | `org_field_values.orgNodeByLevel` — one column per active org level (L2+); **dropdown** from Org Node Lookups |
| ORG STRUCTURE NODE ID | Optional advanced override for `org_structure_node_id` (UUID or label) |
| PAN | pan |
| REPORTING PARTNER | reporting_partner_mobile |
| *{Service titles}* | `client_entity_services.frequency` — dynamic from recurring `task_services` |

Primary org node = deepest filled level column, unless ORG STRUCTURE NODE ID is set.

---

## Sheet: Service List

| Column | Notes |
|--------|--------|
| RECURRING TASK TITLE/SERVICE LIST | Recurring service title |
| FREQUENCY | Dropdown: Daily, Weekly, … |
| TASK ROLL OUT | End of Period / 1 Month Before Period End |
| ONE TIME TASK LIST | One-time service title |

---

## Sheet: Tasks

Same columns as `Task_template.xlsx`. Processed by `taskBulkService.parseAndApply` when included in a full settings upload.

---

## Sheet: Employees

| Column | Maps to |
|--------|---------|
| NAME OF THE EMPLOYEE | users.name |
| MOBILE NUMBER | users.mobile (normalized +91…) |
| REPORTING TO | reporting_to (manager mobile) |
| *{Level labels}* | `user_organizations.org_field_values.orgNodeByLevel` — **dropdown** from Org Node Lookups |
| ORG STRUCTURE NODE ID | Optional advanced override for `primary_org_node_id` |

---

## Single-sheet templates

| Query `?only=` | Filename | Extra sheets |
|----------------|----------|----------------|
| organisation | Entity_Master_template.xlsx (organisation profile only) | — |
| organisation-structure | Org_Structure_template.xlsx | Instructions, Org Node Lookups |
| entity-list | Entity_List_template.xlsx | Instructions, Org Node Lookups |
| service-list | Service_List_template.xlsx | — |
| employees | Employee_template.xlsx | Instructions, Org Node Lookups |
| (none) | OrgIt_Settings_template.xlsx | All sheets above |

## API

- `GET /api/admin/entity-master/template`
- `POST /api/admin/entity-master/upload`
- `GET /api/admin/entity-master/status/:uploadId`
