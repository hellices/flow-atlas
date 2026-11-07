export const listNotes = async (query: unknown) => ({ notes: [], query });
export const createNote = async (note: unknown) => ({ note });
export const getNote = async (slug: string) => ({ slug });
export const deleteNote = async (slug: string) => slug;
