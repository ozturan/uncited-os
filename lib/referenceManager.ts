import { Entry } from './types';

export type ReferenceManager = 'mendeley' | 'bibtex' | 'endnote' | 'zotero';

/**
 * Generate BibTeX citation for a paper
 */
export function generateBibTeX(entry: Entry): string {
  // Extract year from published date
  const year = entry.published ? new Date(entry.published).getFullYear() : new Date().getFullYear();
  
  // Generate citation key from first author and year
  const firstAuthor = entry.authors?.split(/[,&]/)[0]?.trim() || 'Unknown';
  const authorKey = firstAuthor.split(/\s+/).pop()?.toLowerCase() || 'unknown';
  const citeKey = `${authorKey}${year}`;
  
  // Determine entry type
  const entryType = entry.type === 'Review' ? 'article' : 
                   entry.type === 'Preprint' ? 'article' : 
                   'article';
  
  // Format authors
  const authors = entry.authors 
    ? entry.authors.split(/[,&]/).map(a => a.trim()).join(' and ')
    : 'Unknown';
  
  // Build BibTeX
  let bibtex = `@${entryType}{${citeKey},\n`;
  bibtex += `  title = {${entry.title}},\n`;
  bibtex += `  author = {${authors}},\n`;
  bibtex += `  journal = {${entry.journal}},\n`;
  bibtex += `  year = {${year}},\n`;
  
  if (entry.doi) {
    bibtex += `  doi = {${entry.doi}},\n`;
  }
  
  if (entry.published) {
    const date = new Date(entry.published);
    bibtex += `  month = {${date.toLocaleString('en-US', { month: 'long' })}},\n`;
  }
  
  bibtex += `  url = {${entry.link}}\n`;
  bibtex += `}`;
  
  return bibtex;
}




/**
 * Generate Mendeley URL
 * Mendeley uses a web importer or API
 */
export function generateMendeleyURL(entry: Entry): string {
  // Mendeley web importer
  const url = entry.doi ? `https://doi.org/${entry.doi}` : entry.link;
  return `https://www.mendeley.com/import/?url=${encodeURIComponent(url)}`;
}

/**
 * Generate EndNote URL
 * EndNote uses a web importer
 */
export function generateEndNoteURL(entry: Entry): string {
  const url = entry.doi ? `https://doi.org/${entry.doi}` : entry.link;
  return `https://www.myendnoteweb.com/EndNoteWeb.html?func=directExport&url=${encodeURIComponent(url)}`;
}

/**
 * Export to Zotero using local connector API
 * Zotero must be running on the user's machine
 */
async function exportToZotero(entry: Entry): Promise<void> {
  const ZOTERO_API_URL = 'http://127.0.0.1:23119/connector';

  // Build item data in Zotero format
  const zoteroItem = {
    itemType: 'journalArticle',
    title: entry.title,
    creators: entry.authors
      ? entry.authors.split(/[,&]/).map(author => {
          const trimmed = author.trim();
          const parts = trimmed.split(/\s+/);
          return {
            creatorType: 'author',
            firstName: parts.slice(0, -1).join(' '),
            lastName: parts[parts.length - 1] || trimmed
          };
        })
      : [],
    abstractNote: entry.abstract || '',
    publicationTitle: entry.journal,
    date: entry.published || '',
    DOI: entry.doi || '',
    url: entry.link,
    accessDate: new Date().toISOString().split('T')[0]
  };

  try {
    // First check if Zotero is running
    const pingResponse = await fetch(`${ZOTERO_API_URL}/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!pingResponse.ok) {
      throw new Error('Zotero not responding');
    }

    // Save the item to Zotero
    const saveResponse = await fetch(`${ZOTERO_API_URL}/saveItems`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [zoteroItem],
        uri: entry.link
      })
    });

    if (!saveResponse.ok) {
      throw new Error('Failed to save to Zotero');
    }

    // Success - Zotero will show a notification
  } catch (error) {
    // Fallback: download RIS file if Zotero API fails
    console.warn('Zotero API failed, falling back to RIS download:', error);
    const ris = generateRIS(entry);
    const blob = new Blob([ris], { type: 'application/x-research-info-systems' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const firstAuthor = entry.authors?.split(/[,&]/)[0]?.trim().split(/\s+/).pop() || 'paper';
    const year = entry.published ? new Date(entry.published).getFullYear() : new Date().getFullYear();
    a.download = `${firstAuthor}${year}.ris`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

/**
 * Generate RIS citation format for Zotero
 * RIS is a universal format that Zotero can import directly
 */
export function generateRIS(entry: Entry): string {
  // Extract year and month from published date
  const publishedDate = entry.published ? new Date(entry.published) : new Date();
  const year = publishedDate.getFullYear();
  const month = String(publishedDate.getMonth() + 1).padStart(2, '0');
  const day = String(publishedDate.getDate()).padStart(2, '0');

  // Determine type code
  const typeCode = entry.type === 'Review' ? 'RPRT' :
                   entry.type === 'Preprint' ? 'UNPB' :
                   'JOUR'; // Journal Article

  // Build RIS format
  let ris = `TY  - ${typeCode}\n`;
  ris += `TI  - ${entry.title}\n`;

  // Authors
  if (entry.authors) {
    const authors = entry.authors.split(/[,&]/).map(a => a.trim());
    authors.forEach(author => {
      ris += `AU  - ${author}\n`;
    });
  }

  ris += `JO  - ${entry.journal}\n`;
  ris += `PY  - ${year}/${month}/${day}\n`;
  ris += `Y1  - ${year}/${month}/${day}\n`;

  if (entry.doi) {
    ris += `DO  - ${entry.doi}\n`;
  }

  if (entry.abstract) {
    ris += `AB  - ${entry.abstract}\n`;
  }

  ris += `UR  - ${entry.link}\n`;

  if (entry.pdfLink) {
    ris += `L1  - ${entry.pdfLink}\n`;
  }

  ris += `ER  - \n`;

  return ris;
}

/**
 * Export paper to reference manager
 */
export function exportToReferenceManager(entry: Entry, manager: ReferenceManager): void {
  switch (manager) {
    case 'mendeley':
      window.open(generateMendeleyURL(entry), '_blank');
      break;

    case 'endnote':
      window.open(generateEndNoteURL(entry), '_blank');
      break;

    case 'zotero':
      // Try to use Zotero's local API to save directly
      exportToZotero(entry);
      break;

    case 'bibtex':
      // Copy BibTeX to clipboard
      const bibtex = generateBibTeX(entry);
      navigator.clipboard.writeText(bibtex).catch(() => {
        // Fallback: show in alert if clipboard fails
        alert(bibtex);
      });
      break;
  }
}

/**
 * Get display name for reference manager
 */
export function getReferenceManagerName(manager: ReferenceManager): string {
  const names: Record<ReferenceManager, string> = {
    mendeley: 'Mendeley',
    bibtex: 'BibTeX',
    endnote: 'EndNote',
    zotero: 'Zotero'
  };
  return names[manager];
}

/**
 * Get icon/emoji for reference manager
 */
export function getReferenceManagerIcon(manager: ReferenceManager): string {
  const icons: Record<ReferenceManager, string> = {
    mendeley: '📖',
    bibtex: '📋',
    endnote: '📑',
    zotero: '🔖'
  };
  return icons[manager];
}

