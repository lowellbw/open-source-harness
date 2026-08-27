export {
  toPdf,
  toImages,
  isRenderable,
  resolveOffice,
  clearOfficeCache,
  type RenderOptions,
  type RenderResult,
} from './render.js'
export {
  buildDocx,
  buildPptx,
  buildXlsx,
  docxSpecSchema,
  pptxSpecSchema,
  xlsxSpecSchema,
  type DocxSpec,
  type PptxSpec,
  type XlsxSpec,
} from './build.js'
export {
  verifyDocument,
  type GateName,
  type GateResult,
  type VerifyResult,
  type VerifyOptions,
  type AppearanceJudge,
} from './verify.js'
