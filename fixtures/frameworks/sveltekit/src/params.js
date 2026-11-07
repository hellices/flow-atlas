import { defineParams } from '@sveltejs/kit/params';

export const params = defineParams({
	integer: (param) => {
		if (!/^\d+$/.test(param)) return;
		return param;
	},
	locale: (param) => {
		if (param !== 'en' && param !== 'de') return;
		return param;
	}
});
