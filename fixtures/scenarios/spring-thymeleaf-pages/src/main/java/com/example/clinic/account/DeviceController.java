package com.example.clinic.account;

import org.springframework.stereotype.Controller;
import org.springframework.ui.ModelMap;
import org.springframework.validation.BindingResult;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;

@Controller
@RequestMapping("/accounts/{accountId}")
class DeviceController {

	private static final String VIEWS_DEVICE_FORM = "devices/editForm";

	@GetMapping("/devices/new")
	public String initCreationForm(Account account, ModelMap model) {
		model.put("device", new Device());
		return VIEWS_DEVICE_FORM;
	}

	@PostMapping("/devices/new")
	public String processCreationForm(Account account, Device device, BindingResult result) {
		if (result.hasErrors()) {
			return VIEWS_DEVICE_FORM;
		}
		account.addDevice(device);
		return "redirect:/accounts/{accountId}";
	}

	@GetMapping("/devices/{deviceId}/tickets/new")
	public String initNewTicketForm() {
		return "devices/ticketForm";
	}

	@PostMapping("/devices/{deviceId}/tickets/new")
	public String processNewTicketForm(Ticket ticket, BindingResult result) {
		if (result.hasErrors()) {
			return "devices/ticketForm";
		}
		return "redirect:/accounts/{accountId}";
	}

}
