package lab;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;
import static org.hamcrest.Matchers.aMapWithSize;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = "spring.main.banner-mode=off")
@AutoConfigureMockMvc
class ApiDocsTest {
  @Autowired MockMvc mvc;

  @Test
  void writeApiDocs() throws Exception {
    String doc =
        mvc.perform(get("/v3/api-docs"))
            .andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
            .andExpect(jsonPath("$.openapi").isString())
            // The operations OrdersApplication serves, and nothing else: the hidden route stays out.
            .andExpect(jsonPath("$.paths", aMapWithSize(3)))
            .andExpect(jsonPath("$.paths['/api/v1/orders'].post.operationId").value("create"))
            .andExpect(jsonPath("$.paths['/api/v1/orders/{orderId}'].get.operationId").value("read"))
            .andExpect(jsonPath("$.paths['/api/v1/orders/{orderId}/history'].get.operationId").value("orderHistory"))
            .andReturn()
            .getResponse()
            .getContentAsString();
    Files.writeString(Path.of(System.getProperty("out", "java-springdoc.json")), doc);
  }
}
