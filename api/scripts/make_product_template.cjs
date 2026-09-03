const ExcelJS = require('exceljs');
const path = require('path');
(async () => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CartIQ';
  wb.created = new Date();
  const sheet = wb.addWorksheet('Products');
  sheet.columns = [
    { header: 'name*', key: 'name', width: 24 },
    { header: 'category', key: 'category', width: 16 },
    { header: 'basePrice*', key: 'basePrice', width: 12 },
    { header: 'flavors', key: 'flavors', width: 28 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4E3D3' } };
  sheet.addRow({ name: 'Cheese Fries', category: 'Fries', basePrice: 79, flavors: 'Cheese;BBQ' });
  sheet.addRow({ name: 'Soda',        category: 'Drinks', basePrice: 35, flavors: '' });
  sheet.addRow({ name: 'Cheese Sticks', category: 'Sides', basePrice: 59, flavors: 'Cheese' });
  const out = path.resolve(process.argv[2]);
  await wb.xlsx.writeFile(out);
  console.log('Wrote', out);
})().catch((e) => { console.error(e); process.exit(1); });
