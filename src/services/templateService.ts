import Handlebars from 'handlebars';

// Helpers used by system (locked) templates.
// Safe to register multiple times; Handlebars will overwrite with same implementation.
Handlebars.registerHelper('inc', (value: any) => {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? '0'), 10);
  if (Number.isNaN(n)) return 1;
  return n + 1;
});

/**
 * Replace template variables using Handlebars syntax
 * @param template - Template string with placeholders like {{variableName}}
 * @param data - Data object to replace placeholders
 * @returns Rendered template with replaced variables
 */
export function replaceTemplateVariables(
  template: string,
  data: Record<string, any>
): string {
  try {
    const compiledTemplate = Handlebars.compile(template);
    return compiledTemplate(data);
  } catch (error: any) {
    throw new Error(`Template compilation error: ${error.message}`);
  }
}

/**
 * Merge header and body templates into a complete HTML document
 * @param headerTemplate - Header template (auto-filled, read-only)
 * @param bodyTemplate - Body template (user-editable)
 * @param headerData - Data for header placeholders
 * @param bodyData - Data for body placeholders
 * @returns Complete HTML document
 */
export function mergeHeaderAndBody(
  headerTemplate: string,
  bodyTemplate: string,
  headerData: Record<string, any>,
  bodyData: Record<string, any>
): string {
  const renderedHeader = replaceTemplateVariables(headerTemplate || '', headerData);
  const renderedBody = replaceTemplateVariables(bodyTemplate || '', bodyData);

  // Wrap in a complete HTML document with basic styling
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 20px;
      color: #333;
    }
    .header {
      margin-bottom: 30px;
      border-bottom: 2px solid #ddd;
      padding-bottom: 20px;
    }
    .body {
      margin-top: 20px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
    }
    table th, table td {
      border: 1px solid #ddd;
      padding: 8px;
      text-align: left;
    }
    table th {
      background-color: #f2f2f2;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <div class="header">
    ${renderedHeader}
  </div>
  <div class="body">
    ${renderedBody}
  </div>
</body>
</html>
  `.trim();
}

/**
 * Validate filled data against template schema
 * @param schema - Template schema defining editable fields
 * @param filledData - User-filled data to validate
 * @returns Validation result with errors if any
 */
export function validateFilledData(
  schema: any,
  filledData: any
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!schema || !schema.editableFields || !Array.isArray(schema.editableFields)) {
    return { valid: true, errors: [] }; // No schema means no validation needed
  }

  const editableFields = schema.editableFields;

  for (const field of editableFields) {
    const fieldName = field.name;
    const fieldValue = filledData[fieldName];

    // Check required fields
    if (field.required && (fieldValue === undefined || fieldValue === null || fieldValue === '')) {
      errors.push(`${field.label || fieldName} is required`);
      continue;
    }

    // Skip validation if field is empty and not required
    if (!field.required && (fieldValue === undefined || fieldValue === null || fieldValue === '')) {
      continue;
    }

    // Type validation
    if (field.type === 'number' && fieldValue !== undefined && fieldValue !== null) {
      if (isNaN(Number(fieldValue))) {
        errors.push(`${field.label || fieldName} must be a number`);
      }
    }

    if (field.type === 'date' && fieldValue !== undefined && fieldValue !== null) {
      const date = new Date(fieldValue);
      if (isNaN(date.getTime())) {
        errors.push(`${field.label || fieldName} must be a valid date`);
      }
    }

    if (field.type === 'email' && fieldValue !== undefined && fieldValue !== null) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(String(fieldValue))) {
        errors.push(`${field.label || fieldName} must be a valid email`);
      }
    }

    // Array validation
    if (field.type === 'array' && fieldValue !== undefined && fieldValue !== null) {
      if (!Array.isArray(fieldValue)) {
        errors.push(`${field.label || fieldName} must be an array`);
      } else if (field.fields && Array.isArray(field.fields)) {
        // Validate array items
        fieldValue.forEach((item: any, index: number) => {
          field.fields.forEach((subField: any) => {
            const subFieldValue = item[subField.name];
            if (subField.required && (subFieldValue === undefined || subFieldValue === null || subFieldValue === '')) {
              errors.push(`${field.label || fieldName}[${index}].${subField.label || subField.name} is required`);
            }
          });
        });
      }
    }

    // Min/Max validation
    if (field.min !== undefined && fieldValue !== undefined && fieldValue !== null) {
      if (Number(fieldValue) < field.min) {
        errors.push(`${field.label || fieldName} must be at least ${field.min}`);
      }
    }

    if (field.max !== undefined && fieldValue !== undefined && fieldValue !== null) {
      if (Number(fieldValue) > field.max) {
        errors.push(`${field.label || fieldName} must be at most ${field.max}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

