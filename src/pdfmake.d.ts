// The browser build of pdfmake ships without types; lib/book-export.ts describes the part it uses.
declare module 'pdfmake/build/pdfmake.min.js' {
  const pdfMake: unknown;
  export default pdfMake;
}
