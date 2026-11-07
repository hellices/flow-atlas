package com.example.clinic.catalog;

import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseBody;

@Controller
class CatalogController {

	private final ItemRepository items;

	CatalogController(ItemRepository items) {
		this.items = items;
	}

	@GetMapping("/catalog.html")
	public String showCatalogList(@RequestParam(defaultValue = "1") int page, Model model) {
		Page<Item> paginated = findPaginated(page);
		if (page > paginated.getTotalPages()) {
			return "redirect:/catalog.html";
		}
		return addPaginationModel(page, paginated, model);
	}

	private String addPaginationModel(int page, Page<Item> paginated, Model model) {
		model.addAttribute("currentPage", page);
		model.addAttribute("listItems", paginated.getContent());
		return "catalog/list";
	}

	private Page<Item> findPaginated(int page) {
		return items.findAll(PageRequest.of(page - 1, 5));
	}

	@GetMapping({ "/catalog" })
	public @ResponseBody Items showResourcesCatalogList() {
		Items catalog = new Items();
		catalog.getItemList().addAll(this.items.findAll());
		return catalog;
	}

}
