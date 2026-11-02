package lab;

import io.swagger.v3.oas.annotations.Hidden;
import io.swagger.v3.oas.annotations.Operation;
import java.util.List;
import java.util.Map;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication
public class OrdersApplication {
  public static void main(String[] args) {
    ConfigurableApplicationContext ctx = SpringApplication.run(OrdersApplication.class, "--server.port=0", "--logging.level.root=WARN", "--spring.main.banner-mode=off");
    ctx.close();
  }

}

@RestController
@RequestMapping("/api/v1/orders")
class OrdersController {
  @GetMapping("/{orderId}")
  Map<String, String> read(@PathVariable String orderId) {
    return Map.of("id", orderId);
  }

  @PostMapping
  Map<String, Object> create(@RequestBody Map<String, Object> body) {
    return body;
  }

  @GetMapping("/{orderId}/history")
  @Operation(operationId = "orderHistory")
  List<String> history(@PathVariable String orderId) {
    return List.of();
  }

  @Hidden
  @GetMapping("/internal/health")
  Map<String, String> health() {
    return Map.of();
  }
}
