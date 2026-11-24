// src/app 의 화면 코드(.ts/.tsx, api 제외, *.text.ts 제외)에서 한글이 든 문자열·JSX 글자를 찾는다(주석은 보지 않는다).
// usage: node hangul-ast-check.cjs <repo>
const path = require('path');
const fs = require('fs');
const repo = process.argv[2];
const ts = require(path.join(repo, 'node_modules/typescript'));
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const root = path.join(repo, 'src/app');
const files = [];
(function walk(d) {
  for (const n of fs.readdirSync(d)) {
    const f = path.join(d, n);
    if (fs.statSync(f).isDirectory()) { if (f !== path.join(root, 'api')) walk(f); }
    else if (/\.tsx?$/.test(n) && !/\.text\.ts$/.test(n)) files.push(f);
  }
})(root);
let hits = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  (function visit(node) {
    const k = node.kind;
    const isText = k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral || k === ts.SyntaxKind.TemplateHead ||
      k === ts.SyntaxKind.TemplateMiddle || k === ts.SyntaxKind.TemplateTail || k === ts.SyntaxKind.JsxText || k === ts.SyntaxKind.RegularExpressionLiteral;
    if (isText && HANGUL.test(node.getText(sf))) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      console.log(`${path.relative(repo, f)}:${line + 1}: ${node.getText(sf).slice(0, 100)}`);
      hits++;
    }
    ts.forEachChild(node, visit);
  })(sf);
}
console.log(`checked ${files.length} files, ${hits} Hangul string/JSX-text hits outside *.text.ts`);
