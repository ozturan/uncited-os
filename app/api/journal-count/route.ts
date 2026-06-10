import { NextResponse } from 'next/server';
import { getAllJournalIds } from '@/lib/journalFetcher';

// OPTIMIZED: Use ISR to reduce CPU usage
export const revalidate = 3600; // Revalidate every hour

export async function GET() {
  try {
    const journalIds = await getAllJournalIds();
    const totalJournals = journalIds.length;

    return NextResponse.json({ total: totalJournals }, {
      headers: {
        // OPTIMIZED: Increased cache time since journal count changes infrequently
        'Cache-Control': 'public, s-maxage=7200, stale-while-revalidate=14400', // Cache for 2 hours, serve stale for 4 hours
      },
    });
  } catch (error) {
    console.error('Failed to load journal count:', error);
    return NextResponse.json({ total: 0 }, {
      status: 200,
      headers: {
        'Cache-Control': 'public, s-maxage=300', // Cache errors for 5 minutes
      },
    });
  }
}

