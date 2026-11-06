package lab;

import static org.hamcrest.Matchers.aMapWithSize;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

/** Where springdoc serves the documents of CatalogApplication, with no profile active: what atlas should find. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK)
@AutoConfigureMockMvc
class ServedDocumentsTest {
  @Autowired MockMvc mvc;

  @Test
  void servesTheDefaultDocumentAtTheConfiguredPath() throws Exception {
    mvc.perform(get("/api-docs")).andExpect(status().isOk()).andExpect(jsonPath("$.paths", aMapWithSize(2)));
    mvc.perform(get("/api-docs.yaml")).andExpect(status().isOk());
    mvc.perform(get("/v3/api-docs")).andExpect(status().isNotFound());
  }

  @Test
  void servesOneDocumentPerGroupUnderIt() throws Exception {
    mvc.perform(get("/api-docs/public"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.paths", aMapWithSize(1)))
        .andExpect(jsonPath("$.paths['/api/items']").exists());
    mvc.perform(get("/api-docs/internal"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.paths", aMapWithSize(1)))
        .andExpect(jsonPath("$.paths['/internal/items']").exists());
  }

  @Test
  void leavesAProfileFileOutUntilItsProfileIsActive() throws Exception {
    mvc.perform(get("/dev-docs")).andExpect(status().isNotFound());
  }
}
