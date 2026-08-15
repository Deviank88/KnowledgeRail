export const DOCX_COLORS = {
  darkBlue:     "1B3A5C",
  mediumBlue:   "2E75B6",
  body:         "333333",
  gray:         "999999",
  subtitleGray: "666666",
  metadataGray: "888888",
  tableBorder:  "CCCCCC",
  white:        "FFFFFF",
} as const;

export const DOCX_PAGE = {
  width:        11906,
  height:       16838,
  margin:       1440,
  contentWidth: 9026,
} as const;

export const DOCX_NUMBERING = {
  bulletReference: "silverfir-bullet-list",
} as const;

export const DOCX_STYLES = {
  normal: "Normale",
  heading1: "Titolo1",
  heading2: "Titolo2",
  heading3: "Titolo3",
  listParagraph: "Paragrafoelenco",
} as const;
