/** @type {import('./$types').PageServerLoad} */
export function load() {
	return { todos: [] };
}

/** @satisfies {import('./$types').Actions} */
export const actions = {
	create: async ({ request }) => ({ created: (await request.formData()).get('text') }),
	remove: async ({ request }) => ({ removed: (await request.formData()).get('id') })
};
