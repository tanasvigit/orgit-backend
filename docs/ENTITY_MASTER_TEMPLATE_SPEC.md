# Entity Master Template: OrgIt Settings

Single source of truth for the **OrgIt Settings** Excel template: workbook name, sheet order, column names, and their mapping to database/API.

- **Workbook name:** "OrgIt Settings"
- **Download filename:** `OrgIt_Settings_template.xlsx`

## Sheet order (template)

1. **Entity Master (Organisation)** – organisation master data (11 columns only; see Sheet 1)
2. **Entity List** – NAME OF THE CLIENT, ENTITY TYPE, COST CENTRE, DEPOT, WAREHOUSE + compliance/tax columns
3. **Service List** – RECURRING TASK TITLE/SERVICE LIST, FREQUENCY, TASK ROLL OUT, ONE TIME TASK LIST
4. **Employees** – NAME OF THE EMPLOYEE, MOBILE NUMBER, DESIGNATON, REPORTING TO, LEVEL
5. **Cost Centres**
6. **Branches**
7. **Depot**
8. **Warehouse**
9. **Client Entity Services**

On upload, the parser accepts **Entity List** or **Client Entities** for client/entity data (same mapping to `client_entities`). **Service List** is optional; if the sheet is missing, it is skipped (no error).

---

## Sheet 1: Entity Master (Organisation)

Template uses sheet name **"Entity Master (Organisation)"** (≤31 chars; Excel truncates longer names). Parser accepts **"Entity Master (Organisation)"**, truncated **"ENTITY MASTER DATA (Organisati)"**, or legacy **"Organizations"**.

**Layout:** The template uses a **vertical layout**: column A = field labels (one per row), column B = values. Row order: Name of the Organisation, Short Name, E Mail ID, Web Site, Phone Number, Org Constitution, PAN of the Organisation, GST Number, CIN Number, Depot, Warehouse, Country, State, City, Pin Code, Address Line 1, Address Line 2. Org Constitution has a dropdown. Cost Centre / Branches / Departments are on separate sheets and UI.

**Upload:** Parser supports **both** vertical and horizontal layouts. If row 1 column A is "Name of the Organisation" or "Short Name", the sheet is read as vertical (one org; values from column B). Otherwise row 1 = headers, data from row 2 (horizontal). Legacy keys and display names accepted. Optional column **organization_name** (horizontal only): super_admin can target org by name.

| Column (exact in template) | DB column | Type | Required | Notes |
|----------------------------|-----------|------|----------|--------|
| Name of the Organisation | name | string | Yes | |
| Short Name | short_name | string | No | |
| Address of the Organisation | address | text | No | |
| E Mail ID | email | string | No | |
| Web Site | website | string | No | |
| Phone Number | phone_number | string | No | |
| Org Constitution | org_constitution | string | No | proprietor, partnership_firm, private_limited_company, public_limited_company, trust, society, co_operative_society, association_of_persons |
| PAN of the Organisation | pan | string | No | 5 letters + 4 digits + 1 letter |
| GST Number | gst | string | No | |
| Depot | depot_count | integer | No | Default 0 |
| Warehouse | warehouse_count | integer | No | Default 0 |
| CIN Number | cin | string | No | |
| Country | country_name | string | No | Resolved to country_id |
| State | state_name | string | No | Resolved to state_id |
| City | city_name | string | No | Resolved to city_id |
| Pin Code | pin_code | string | No | |
| Address Line 1 | address_line1 | string | No | |
| Address Line 2 | address_line2 | string | No | |

**Upload:** Parser also accepts legacy keys (e.g. `name`, `short_name`, `email`) and display names (e.g. "Name of the Organisation", "E Mail ID"). Optional column **organization_name** (not in template): if present in an uploaded file, super_admin can use it to target the org by name; admin ignores it. Only the fields above (plus `updated_at`) are written to `organizations` from this sheet; country_id, state_id, city_id, pin_code, address_line1, address_line2, mobile, cin, logo_url, accounting_year_start are not set from this sheet.

## Sheet 2: Employees

Template has **5 columns only**; no DEPARTMENT column. Parser accepts column headers (case-insensitive): **NAME OF THE EMPLOYEE** or **name**, **MOBILE NUMBER** or **mobile**, **DESIGNATON** (or DESIGNATION), **REPORTING TO** or **reporting_to_mobile**, **LEVEL**. **REPORTING TO** is the manager’s **mobile number** (used to resolve reporting_to user within the same org). If an old file includes a DEPARTMENT column, parser treats it as optional (not in template).

| Column (exact in template) | DB column | Type | Required | Notes |
|---------------------------|-----------|------|----------|--------|
| NAME OF THE EMPLOYEE | name | string | Yes | Employee name |
| MOBILE NUMBER | mobile | string | Yes | International format (+911234567890). Used to match/create user |
| DESIGNATON | designation | string | No | Stored in user_organizations |
| REPORTING TO | → reporting_to | string | No | **Manager’s mobile number**; resolve to user_id within same org |
| LEVEL | level | string | No | e.g. L1, L2 |

Legacy columns also accepted: name, mobile, designation, reporting_to_mobile, level; department (optional if present in upload).

New users are created with default password; they must change on first login.

## Sheet 3: Cost Centres

Parser accepts **"Cost Centres"** or **"Cost centres"**.

| Column (exact) | DB column | Type | Required | Notes |
|----------------|-----------|------|----------|--------|
| organization_name | → organization_id | string | No | Blank = current user's org |
| name | name | string | Yes | Unique per org |
| short_name | short_name | string | No | |
| display_order | display_order | integer | No | Default 0 |

## Sheet 4: Branches

| Column (exact) | DB column | Type | Required | Notes |
|----------------|-----------|------|----------|--------|
| organization_name | → organization_id | string | No | Blank = current user's org |
| name | name | string | Yes | |
| short_name | short_name | string | No | |
| address | address | text | No | |
| gst_number | gst_number | string | No | |

## Sheet 5: Depot

Depot list (like Cost Centres). Parser accepts **"Depot"** or **"Depots"**.

| Column (exact) | DB column | Type | Required | Notes |
|----------------|-----------|------|----------|--------|
| organization_name | → organization_id | string | No | Blank = current user's org |
| name | name | string | Yes | Unique per org |
| short_name | short_name | string | No | |
| display_order | display_order | integer | No | Default 0 |

## Sheet 6: Warehouse

Warehouse list (like Branches). Parser accepts **"Warehouse"** or **"Warehouses"**.

| Column (exact) | DB column | Type | Required | Notes |
|----------------|-----------|------|----------|--------|
| organization_name | → organization_id | string | No | Blank = current user's org |
| name | name | string | Yes | |
| short_name | short_name | string | No | |
| address | address | text | No | |
| gst_number | gst_number | string | No | |

## Sheet 7: Service List

Included in the template. If this sheet is missing in an uploaded file, it is skipped (no error).

**New format (template columns):** (template does not include organization_name; upload uses current user's org)

| Column (exact in template) | DB column | Type | Required | Notes |
|----------------------------|-----------|------|----------|--------|
| RECURRING TASK TITLE/SERVICE LIST | title | string | No | Recurring task title → task_type = recurring |
| FREQUENCY | frequency | string | No | Daily, Weekly, Fortnightly, Monthly, Quarterly, Half Yearly, Yearly, NA, Custom (used for recurring) |
| TASK ROLL OUT | rollout_rule | string | No | End of period / One month before period end (for recurring) |
| ONE TIME TASK LIST | title | string | No | One-time task title → task_type = one_time |

One row can have a recurring task (first three columns) and/or a one-time task (last column). Legacy columns **organization_name**, **title**, **task_type**, **frequency**, **rollout_rule**, **is_active** are also accepted on upload if present.

## Sheet 6: Entity List / Client Entities

Parser accepts **"Entity List"**, **"Client Entities"**, or **"Client entities"**. Same mapping to `client_entities`; **Entity List** uses display headers NAME OF THE CLIENT, ENTITY TYPE, COST CENTRE. Template does not include organization_name; upload uses current user's org. If organization_name column is present in an uploaded file, it is used for super_admin targeting.

| Column (exact) | DB column | Type | Required | Notes |
|----------------|-----------|------|----------|--------|
| organization_name | → organization_id | string | No | Not in template; if present in upload, super_admin can target org by name. Blank = current user's org |
| NAME OF THE CLIENT / name | name | string | Yes | Unique per org (client name) |
| ENTITY TYPE / entity_type | entity_type | string | No | e.g. Individual, Company |
| COST CENTRE / cost_centre_name | → cost_centre_id | string | No | Resolve by name within same org |
| DEPOT / depot_name | → depot_id | string | No | Resolve by name within same org |
| WAREHOUSE / warehouse_name | → warehouse_id | string | No | Resolve by name within same org |

**Entity List** template columns (exact headers): NAME OF THE CLIENT, ENTITY TYPE, COST CENTRE, DEPOT, WAREHOUSE, GSTR 1, GSTR 1A, … Only **name**, **entity_type**, **cost_centre_id**, **depot_id**, and **warehouse_id** are persisted to `client_entities`; compliance columns remain template-only unless the schema is extended.

## Sheet 8: Client Entity Services (matrix)

Parser accepts **"Client Entity Services"** or **"Client entity services"**.

| Column (exact) | DB column | Type | Required | Notes |
|----------------|-----------|------|----------|--------|
| client_entity_name | → client_entity_id | string | Yes | Resolve by name within org |
| task_service_title | → task_service_id | string | Yes | Resolve by title + task_type |
| task_type | (for lookup) | string | Yes | recurring or one_time |
| frequency | frequency | string | Yes | Daily, Weekly, Fortnightly, Monthly, Quarterly, Half Yearly, Yearly, NA, Custom |

## Processing order

Entity Master (Organisation) → Cost Centres → Branches → Depot → Warehouse → Service List (if present) → Entity List / Client Entities → Client Entity Services → Employees.

## Validation enums

- **org_constitution:** proprietor, partnership_firm, private_limited_company, public_limited_company, trust, society, co_operative_society, association_of_persons
- **task_type:** recurring, one_time
- **frequency (task_services / client_entity_services):** Daily, Weekly, Fortnightly, Monthly, Quarterly, Half Yearly, Yearly, NA, Custom
- **rollout_rule (task_services only):** end_of_period, one_month_before_period_end

## API / Auth

- **GET /api/admin/entity-master/template** – Returns `OrgIt_Settings_template.xlsx` with the sheets and headers above. Auth: admin or super_admin (with organization).
- **POST /api/admin/entity-master/upload** – Multipart file (.xlsx or .xls). Auth: admin or super_admin. Admin is restricted to their organization_id; super_admin can use organization_name to target orgs.
