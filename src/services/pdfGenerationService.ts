import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../config/database';
import { getOrganizationData, formatOrganizationDataForTemplate } from './entityMasterService';
import { mergeHeaderAndBody } from './templateService';
import { renderDocumentFromState } from './builderRendererService';
import { isConfigured as isS3Configured, upload as s3Upload } from './s3StorageService';
import { injectGstInvoicePdfLayoutLock } from './gstInvoicePdfLayoutLock';
import { getSharedPdfBrowser } from './pdfBrowserPool';

const PDF_OUTPUT_DIR = process.env.PDF_OUTPUT_DIR || './uploads/document-pdfs';

// Ensure PDF output directory exists
fs.mkdir(PDF_OUTPUT_DIR, { recursive: true }).catch(console.error);

export interface PDFOptions {
  format?: 'A4' | 'Letter';
  margin?: {
    top?: string;
    right?: string;
    bottom?: string;
    left?: string;
  };
  printBackground?: boolean;
}

/**
 * Generate PDF from HTML string using Puppeteer
 * @param html - HTML content to convert to PDF
 * @param options - PDF generation options
 * @returns PDF buffer
 */
export async function generatePDFFromHTML(
  html: string,
  options: PDFOptions = {}
): Promise<Buffer> {
  const preparedHtml = injectGstInvoicePdfLayoutLock(html);

  let browser: any;
  try {
    browser = await getSharedPdfBrowser();
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes('error while loading shared libraries') || msg.includes('libatk-1.0.so.0')) {
      const error = new Error('PDF generation unavailable: Chromium dependencies missing');
      (error as any).code = 'PDF_GENERATION_UNAVAILABLE';
      (error as any).originalError = msg;
      throw error;
    }
    throw err;
  }

  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1200, height: 1697, deviceScaleFactor: 1 });
    await page.setContent(preparedHtml, { waitUntil: 'load', timeout: 15000 });

    const pdfBuffer = await page.pdf({
      format: options.format || 'A4',
      margin: options.margin || {
        top: '14mm',
        right: '14mm',
        bottom: '14mm',
        left: '14mm',
      },
      printBackground: options.printBackground !== false,
      preferCSSPageSize: true,
    });

    return pdfBuffer;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Generate PDF from template with auto-filled data
 * @param templateId - Template ID
 * @param filledData - User-filled data for body template
 * @param organizationId - Organization ID for auto-fill
 * @returns PDF buffer and file URL
 */
export async function generatePDFFromTemplate(
  templateId: string,
  filledData: Record<string, any>,
  organizationId: string
): Promise<{ pdfBuffer: Buffer; pdfUrl: string }> {
  let completeHTML = '';
  let pdfOptions: PDFOptions = {};

  // Case 1: Document Builder State (Modern)
  // Check if filledData looks like a DocumentBuilder state
  if (filledData && Array.isArray(filledData.sections)) {
    console.log('DEBUG: Using Modern Builder Renderer for PDF');
    // Ensure header details are synchronized if they are missing in the state but present in orgData
    if (!filledData.header?.orgName) {
      const orgData = await getOrganizationData(organizationId);
      filledData.header = {
        ...filledData.header,
        orgName: orgData.name,
        orgAddress: orgData.address || '',
        orgGstin: orgData.gst || '',
        orgEmail: orgData.email || '',
      };
    }
    completeHTML = renderDocumentFromState(filledData as any);
  }
  // Case 2: Legacy Template (Handlebars)
  else {
    console.log('DEBUG: Using Legacy Handlebars Renderer for PDF');
    // Fetch template
    const templateResult = await query(
      `SELECT 
        type,
        header_template,
        body_template,
        template_schema,
        auto_fill_fields,
        pdf_settings
      FROM document_templates
      WHERE id = $1 AND status = 'active'`,
      [templateId]
    );

    if (templateResult.rows.length === 0) {
      throw new Error('Template not found or not active');
    }

    const template = templateResult.rows[0];
    const headerTemplate = template.header_template || '';
    const bodyTemplate = template.body_template || '';
    const isGstInvoiceTemplate =
      /gst-inv-page|gst-inv-root/i.test(bodyTemplate) ||
      template.type === 'gst_invoice_figma';

    const rawSettings = template.pdf_settings;
    if (rawSettings) {
      try {
        pdfOptions =
          typeof rawSettings === 'string' ? JSON.parse(rawSettings) : { ...rawSettings };
      } catch {
        pdfOptions = {};
      }
    }

    // GST invoice uses user-filled data only — skip org DB fetch for faster PDF.
    const headerData = isGstInvoiceTemplate
      ? {}
      : formatOrganizationDataForTemplate(await getOrganizationData(organizationId));

    // Prepare body data - merge user-filled data with any additional formatting
    const bodyData: Record<string, any> = {
      ...filledData,
      // Add common formatting helpers
      formatCurrency: (amount: number) => {
        return new Intl.NumberFormat('en-IN', {
          style: 'currency',
          currency: 'INR',
        }).format(amount);
      },
      formatDate: (date: string) => {
        return new Date(date).toLocaleDateString('en-IN');
      },
    };

    // Merge header and body templates
    completeHTML = mergeHeaderAndBody(
      headerTemplate,
      bodyTemplate,
      headerData,
      bodyData
    );

    // When no logo is provided, hide the .logo box in PDF so it doesn't show an empty square
    // (legacy DB templates may still have the unconditional logo div)
    const hasLogo = !!(
      (headerData && (headerData.company_logo_data_uri || headerData.company_logo_url)) ||
      (bodyData && (bodyData.company_logo_data_uri || bodyData.company_logo_url))
    );
    if (!hasLogo && completeHTML.includes('class="logo"')) {
      completeHTML = completeHTML.replace('</head>', '<style>body.no-org-logo .logo { display: none !important; }</style></head>');
      completeHTML = completeHTML.replace('<body>', '<body class="no-org-logo">');
    }
  }

  const pdfBuffer = await generatePDFFromHTML(completeHTML, pdfOptions);

  let pdfUrl: string;
  if (isS3Configured()) {
    const key = `document-pdfs/${uuidv4()}.pdf`;
    pdfUrl = await s3Upload(key, pdfBuffer, 'application/pdf');
  } else {
    const filename = `document-${uuidv4()}.pdf`;
    const filePath = path.join(PDF_OUTPUT_DIR, filename);
    await fs.writeFile(filePath, pdfBuffer);
    pdfUrl = `/uploads/document-pdfs/${filename}`;
  }

  return { pdfBuffer, pdfUrl };
}

/**
 * Get PDF file path from URL (local only; returns path for filesystem).
 * For S3 keys, use s3StorageService.getObject instead.
 */
export function getPDFFilePath(pdfUrl: string): string {
  if (pdfUrl.startsWith('/uploads/')) {
    return path.join(process.cwd(), pdfUrl);
  }
  return pdfUrl;
}

/**
 * Read PDF file as buffer
 * @param pdfUrl - PDF URL
 * @returns PDF buffer
 */
export async function readPDFFile(pdfUrl: string): Promise<Buffer> {
  const filePath = getPDFFilePath(pdfUrl);
  return await fs.readFile(filePath);
}

