package lab;

import java.util.List;
import org.springdoc.core.models.GroupedOpenApi;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
public class CatalogApplication {
  public static void main(String[] args) {
    SpringApplication.run(CatalogApplication.class, args);
  }
}

@Configuration(proxyBeanMethods = false)
class ApiGroups {
  @Bean
  GroupedOpenApi publicApi() {
    return GroupedOpenApi.builder().group("public").pathsToMatch("/api/**").build();
  }
}

@RestController
class ItemsController {
  @GetMapping("/api/items")
  List<String> list() {
    return List.of();
  }

  @GetMapping("/internal/items")
  List<String> audit() {
    return List.of();
  }
}
