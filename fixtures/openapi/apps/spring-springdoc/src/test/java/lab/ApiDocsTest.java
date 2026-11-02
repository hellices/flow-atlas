package lab;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = "spring.main.banner-mode=off")
@AutoConfigureMockMvc
class ApiDocsTest {
  @Autowired MockMvc mvc;

  @Test
  void writeApiDocs() throws Exception {
    String doc = mvc.perform(get("/v3/api-docs")).andReturn().getResponse().getContentAsString();
    Files.writeString(Path.of(System.getProperty("out", "java-springdoc.json")), doc);
  }
}
