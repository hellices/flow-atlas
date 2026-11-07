package com.example.clinic.account;

import org.springframework.data.domain.Page;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.validation.BindingResult;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.servlet.ModelAndView;

@Controller
class AccountController {

	private static final String VIEWS_ACCOUNT_FORM = "accounts/editForm";

	private final AccountRepository accounts;

	AccountController(AccountRepository accounts) {
		this.accounts = accounts;
	}

	@GetMapping("/accounts/new")
	public String initCreationForm() {
		return VIEWS_ACCOUNT_FORM;
	}

	@PostMapping("/accounts/new")
	public String processCreationForm(Account account, BindingResult result) {
		if (result.hasErrors()) {
			return VIEWS_ACCOUNT_FORM;
		}
		this.accounts.save(account);
		return "redirect:/accounts/" + account.getId();
	}

	@GetMapping("/accounts/find")
	public String initFindForm() {
		return "accounts/find";
	}

	@GetMapping("/accounts")
	public String processFindForm(@RequestParam(defaultValue = "1") int page, Account account, Model model) {
		Page<Account> results = this.accounts.findByName(account.getName(), page);
		if (results.isEmpty()) {
			return "accounts/find";
		}
		if (results.getTotalElements() == 1) {
			return "redirect:/accounts/" + results.iterator().next().getId();
		}
		return addPaginationModel(page, model, results);
	}

	private String addPaginationModel(int page, Model model, Page<Account> paginated) {
		model.addAttribute("currentPage", page);
		model.addAttribute("listAccounts", paginated.getContent());
		return "accounts/list";
	}

	@GetMapping("/accounts/{accountId}/edit")
	public String initUpdateForm() {
		return VIEWS_ACCOUNT_FORM;
	}

	@PostMapping("/accounts/{accountId}/edit")
	public String processUpdateForm(Account account, BindingResult result, @PathVariable("accountId") int accountId) {
		if (result.hasErrors()) {
			return VIEWS_ACCOUNT_FORM;
		}
		this.accounts.save(account);
		return "redirect:/accounts/{accountId}";
	}

	@GetMapping("/accounts/{accountId}")
	public ModelAndView showAccount(@PathVariable("accountId") int accountId) {
		ModelAndView mav = new ModelAndView("accounts/details");
		mav.addObject(this.accounts.findById(accountId));
		return mav;
	}

}
