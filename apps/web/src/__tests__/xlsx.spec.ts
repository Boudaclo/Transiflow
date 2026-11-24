// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { buildXlsx } from '../lib/xlsx';

describe('export Excel', () => {
  const zip = unzipSync(buildXlsx([
    { name: 'Résumé', rows: [['Recettes (FCFA)', 1250000], ['Note', '=CMD|"/c calc"!A1'], ['Accents', 'Ouagadougou & <Bobo>']] },
    { name: 'Lignes/Test?', rows: [['Code'], ['OUA-BOB']] },
  ]));
  it('contient les parties obligatoires d\'un classeur', () => {
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']));
  });
  it('les nombres restent des nombres et les textes sont échappés', () => {
    const s1 = strFromU8(zip['xl/worksheets/sheet1.xml']!);
    expect(s1).toContain('<c r="B1"><v>1250000</v></c>');
    expect(s1).toContain('Ouagadougou &amp; &lt;Bobo&gt;');
  });
  it('une cellule qui commence par = n\'est jamais une formule', () => {
    const s1 = strFromU8(zip['xl/worksheets/sheet1.xml']!);
    expect(s1).not.toContain('<f>');
    expect(s1).toContain('t="inlineStr"');
  });
  it('les noms de feuille interdits sont nettoyés', () => {
    expect(strFromU8(zip['xl/workbook.xml']!)).toContain('name="Lignes Test "');
  });
});
