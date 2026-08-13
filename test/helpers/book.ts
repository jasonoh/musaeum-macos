import type { Book } from '@shared/book.types'

export function makeBook(id: string, title = `Book ${id}`): Book {
  return {
    id,
    title,
    sortTitle: null,
    author: null,
    authorSort: null,
    publisher: null,
    publishedDate: null,
    language: null,
    description: null,
    isbn10: null,
    isbn13: null,
    goodreadsId: null,
    openlibraryId: null,
    seriesName: null,
    seriesIndex: null,
    seriesTotal: null,
    coverThumbPath: null,
    coverFullPath: null,
    formats: ['epub'],
    tags: [],
    rating: null,
    dateAdded: null,
    lastModified: null,
    fileSizeBytes: null,
    readStatus: 'unread',
    nasPath: `books/${id}`,
    readingState: null
  }
}
