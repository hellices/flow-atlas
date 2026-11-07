package com.example.app;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.ResponseBody;

@Controller
public class PageController {

	@RequestMapping(path = {"/help", "/faq"}, method = {RequestMethod.GET, RequestMethod.POST})
	@ResponseBody
	public String help() {
		return "help";
	}

	@RequestMapping("/ping")
	@ResponseBody
	public String ping() {
		return "pong";
	}
}
