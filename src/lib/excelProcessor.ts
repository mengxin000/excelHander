import * as XLSX from 'xlsx';

export interface CleaningOptions {
  removeEmptyRows: boolean;
  deduplicate: boolean;
  dedupStrategy: 'first' | 'last' | 'max' | 'min';
  dedupKeyColumn: string; // The column used to identify duplicates
  dedupCompareColumn: string; // The column used for max/min comparison
  trimWhitespace: boolean;
  unifySeparators: boolean; // Unify Chinese/English commas
  dateFormat: string;
  currencyDecimals: number;
  textCase: 'none' | 'upper' | 'lower' | 'title';
}

export interface ColumnMapping {
  original: string;
  renamed: string;
  order: number;
  processAsDate?: boolean;
  processAsCurrency?: boolean;
}

export interface ProcessResult {
  blob: Blob;
  removedRows: number;
  totalRows: number;
}

export async function processExcelFile(
  file: File,
  options: CleaningOptions,
  columnMappings: ColumnMapping[]
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array', cellDates: true, cellNF: true, cellText: true });
        
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        
        const allRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' }) as any[][];
        
        let headerIndex = allRows.findIndex(row => row.some(cell => cell !== null && cell !== ''));
        if (headerIndex === -1) headerIndex = 0;
        
        const headers = allRows[headerIndex].map(h => String(h || '').trim());
        const rawData = allRows.slice(headerIndex + 1);
        
        let jsonData = rawData.map(row => {
          const obj: any = {};
          headers.forEach((header, i) => {
            if (header) obj[header] = row[i] === undefined ? '' : row[i];
          });
          return obj;
        });

        const initialRowCount = jsonData.length;

        // 1. Standardization (Pre-cleaning for better dedup)
        jsonData = jsonData.map(row => {
          const newRow = { ...row };
          Object.keys(newRow).forEach(key => {
            let val = newRow[key];
            if (typeof val === 'string') {
              if (options.trimWhitespace) val = val.trim();
              if (options.unifySeparators) val = val.replace(/，/g, ',');
            }
            newRow[key] = val;
          });
          return newRow;
        });

        // 2. Smart Deduplication
        if (options.deduplicate) {
          const groups = new Map<string, any[]>();
          
          jsonData.forEach(row => {
            // If no key column specified, use the whole row as key
            const key = options.dedupKeyColumn 
              ? String(row[options.dedupKeyColumn] || '').toLowerCase().trim()
              : JSON.stringify(row);
            
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(row);
          });

          jsonData = Array.from(groups.values()).map(group => {
            if (group.length === 1) return group[0];

            if (options.dedupStrategy === 'first') return group[0];
            if (options.dedupStrategy === 'last') return group[group.length - 1];
            
            if (options.dedupStrategy === 'max' || options.dedupStrategy === 'min') {
              const compareCol = options.dedupCompareColumn || options.dedupKeyColumn;
              return group.reduce((prev, curr) => {
                const prevVal = parseFloat(String(prev[compareCol]).replace(/[^\d.-]/g, '')) || 0;
                const currVal = parseFloat(String(curr[compareCol]).replace(/[^\d.-]/g, '')) || 0;
                if (options.dedupStrategy === 'max') return currVal > prevVal ? curr : prev;
                return currVal < prevVal ? curr : prev;
              });
            }
            return group[0];
          });
        }

        // 3. Empty Row Removal
        if (options.removeEmptyRows) {
          jsonData = jsonData.filter(row => 
            Object.values(row).some(val => val !== null && val !== undefined && String(val).trim() !== '')
          );
        }

        // 4. Formatting
        jsonData = jsonData.map(row => {
          const newRow: any = {};
          Object.keys(row).forEach(key => {
            let val = row[key];
            const mapping = columnMappings.find(m => m.original === key);

            // Text Case
            if (typeof val === 'string' && val !== '') {
              if (options.textCase === 'upper') val = val.toUpperCase();
              else if (options.textCase === 'lower') val = val.toLowerCase();
              else if (options.textCase === 'title') {
                val = val.replace(/\w\S*/g, (txt: string) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
              }
            }

            // Date Standardization
            if (mapping?.processAsDate && val !== '') {
              let d: Date | null = null;
              if (val instanceof Date) d = val;
              else if (typeof val === 'number' && val > 1000) {
                const dateObj = XLSX.SSF.parse_date_code(val) as any;
                if (dateObj) d = new Date(dateObj.y, dateObj.m - 1, dateObj.d);
              } else if (typeof val === 'string') {
                const timestamp = Date.parse(val);
                if (!isNaN(timestamp)) d = new Date(timestamp);
              }
              
              if (d instanceof Date && !isNaN(d.getTime())) {
                const y = d.getFullYear();
                const m = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                val = options.dateFormat.replace('YYYY', String(y)).replace('MM', m).replace('DD', day);
              }
            }

            // Currency Formatting
            if (mapping?.processAsCurrency && val !== '' && val !== null && val !== undefined) {
              const numStr = String(val).replace(/[^\d.-]/g, '');
              const num = parseFloat(numStr);
              if (!isNaN(num)) {
                // Round to specified decimals and keep as number for Excel
                const factor = Math.pow(10, options.currencyDecimals);
                val = Math.round(num * factor) / factor;
              }
            }

            newRow[key] = val;
          });
          return newRow;
        });

        // 5. Column Reordering & Renaming
        if (columnMappings.length > 0) {
          const sortedMappings = [...columnMappings].sort((a, b) => a.order - b.order);
          jsonData = jsonData.map(row => {
            const mappedRow: any = {};
            sortedMappings.forEach(mapping => {
              // Ensure we use the original key to get the value
              const val = row[mapping.original];
              mappedRow[mapping.renamed || mapping.original] = (val === undefined || val === null) ? '' : val;
            });
            return mappedRow;
          });
        }

        const finalRowCount = jsonData.length;

        // 6. Generate File
        const newSheet = XLSX.utils.json_to_sheet(jsonData);
        const range = XLSX.utils.decode_range(newSheet['!ref'] || 'A1');
        
        // Apply cell formats for currency columns
        const currencyHeaders = columnMappings
          .filter(m => m.processAsCurrency)
          .map(m => m.renamed || m.original);
        
        if (currencyHeaders.length > 0) {
          for (let C = range.s.c; C <= range.e.c; ++C) {
            const headerCell = newSheet[XLSX.utils.encode_cell({ r: range.s.r, c: C })];
            if (headerCell && currencyHeaders.includes(headerCell.v)) {
              for (let R = range.s.r + 1; R <= range.e.r; ++R) {
                const cell = newSheet[XLSX.utils.encode_cell({ r: R, c: C })];
                if (cell && cell.t === 'n') {
                  const decimals = options.currencyDecimals;
                  const format = decimals === 0 ? '0' : '0.' + '0'.repeat(decimals);
                  cell.z = format;
                }
              }
            }
          }
        }

        newSheet['!autofilter'] = { ref: XLSX.utils.encode_range(range) };

        const newWorkbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(newWorkbook, newSheet, 'Processed');
        
        const wbout = XLSX.write(newWorkbook, { bookType: 'xlsx', type: 'array' });
        resolve({
          blob: new Blob([wbout], { type: 'application/octet-stream' }),
          removedRows: initialRowCount - finalRowCount,
          totalRows: finalRowCount
        });
      } catch (err) {
        console.error('Processing Error:', err);
        reject(err);
      }
    };
    reader.onerror = (err) => reject(err);
    reader.readAsArrayBuffer(file);
  });
}
