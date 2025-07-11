/**
 * Base document structure with required _id field
 */
export interface Document {
  _id: string;
  [key: string]: unknown;
}
