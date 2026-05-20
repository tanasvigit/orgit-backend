# Entity Master Template: OrgIt Settings

Single source of truth for the **OrgIt Settings** Excel template: workbook name, sheet order, column names, and their mapping to database/API.

- **Workbook name:** OrgIt Settings
- **Download filename:** `OrgIt_Settings_template.xlsx`

## Breaking changes (legacy templates)

The following are **no longer supported**. Uploads containing them fail with an explicit error:

- **Sheets:** Cost Centres, Branches, Depot, Depots, Warehouse, Warehouses, Client Entity Services
- **Entity List columns:** Cost Centre, Depot, Warehouse, Org Unit Name (use per-level columns instead)
- **Employees:** DESIGNATON, LEVEL, DEPARTMENT columns are ignored if present in old files

Download a fresh template from Settings or the relevant admin screen before bulk upload.

## Sheet order (full workbook)

1. **Entity Master Data (Org)** – organisation profile (`organizations`)
2. **Organisation Structure** – hierarchy nodes (`organization_structure_nodes`)
3. **Entity List** – client entities + compliance frequencies
4. **Service List** – task services (`task_services`)
5. **Tasks** – convenience sheet (processed by task bulk parser on full upload)
6. **Employees** – users + org assignments (`user_organizations`)
7. **Structure Reference** – read-only node IDs/paths (not imported)

**Recommended upload order:** Org → Structure → Service List → Entity List → Employees → Tasks.

---

## Sheet 1: Entity Master Data (Org)

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

---

## Sheet 2: Organisation Structure

| Column | Required | Notes |
|--------|----------|--------|
| LEVEL | Yes | Level label (e.g. Group, Region) or level number 1–11 |
| PARENT_NAME | Yes for L2+ | Blank for Group root |
| NAME | Yes | Node name |
| CODE | No | Optional node code |

Rows are processed in level order. Existing nodes match on `(level, parent, name)` and update `code` when provided.

---

## Sheet 3: Entity List

Fixed columns (in order):

| Column | Maps to |
|--------|---------|
| NAME OF THE CLIENT | name |
| ENTITY TYPE | entity_type |
| STATUS | status (Active / Inactive) |
| *{Level labels}* | `org_field_values.orgNodeByLevel` — one column per active org level (L2+) |
| ORG STRUCTURE NODE ID | Optional override for `org_structure_node_id` |
| PAN | pan |
| REPORTING PARTNER | reporting_partner_mobile |
| *{Service titles}* | `client_entity_services.frequency` — dynamic from recurring `task_services` |

Primary org node = deepest filled level column, unless ORG STRUCTURE NODE ID is set.

---

## Sheet 4: Service List

| Column | Notes |
|--------|--------|
| RECURRING TASK TITLE/SERVICE LIST | Recurring service title |
| FREQUENCY | Dropdown: Daily, Weekly, … |
| TASK ROLL OUT | End of Period / 1 Month Before Period End |
| ONE TIME TASK LIST | One-time service title |

---

## Sheet 5: Tasks

Same columns as `Task_template.xlsx`. Processed by `taskBulkService.parseAndApply` when included in a full settings upload.

---

## Sheet 6: Employees

| Column | Maps to |
|--------|---------|
| NAME OF THE EMPLOYEE | users.name |
| MOBILE NUMBER | users.mobile (normalized +91…) |
| REPORTING TO | reporting_to (manager mobile) |
| *{Level labels}* | `user_organizations.org_field_values.orgNodeByLevel` |
| ORG STRUCTURE NODE ID | Optional override for `primary_org_node_id` |

---

## Sheet 7: Structure Reference

Read-only. Columns: NODE_ID, LEVEL, NAME, CODE, FULL_PATH. Use when filling Entity List or Employees.

---

## Single-sheet templates

| Query `?only=` | Filename |
|----------------|----------|
| organisation | Entity_Master_template.xlsx |
| organisation-structure | Org_Structure_template.xlsx |
| entity-list | Entity_List_template.xlsx |
| service-list | Service_List_template.xlsx |
| employees | Employee_template.xlsx |
| (none) | OrgIt_Settings_template.xlsx |

## API

- `GET /api/admin/entity-master/template`
- `POST /api/admin/entity-master/upload`
- `GET /api/admin/entity-master/status/:uploadId`
