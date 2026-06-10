import { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/'],
        disallow: ['/api/', '/app/', '/dashboard/'],
      },
    ],
    sitemap: 'https://uncited.org/sitemap.xml',
  }
}
