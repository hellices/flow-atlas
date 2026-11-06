package lab;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;

/** application-dev.yml moves the documents only when the dev profile is active, which the code does not decide. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK)
@AutoConfigureMockMvc
@ActiveProfiles("dev")
class DevProfileTest {
  @Autowired MockMvc mvc;

  @Test
  void movesTheDocumentsUnderTheProfile() throws Exception {
    mvc.perform(get("/dev-docs")).andExpect(status().isOk());
    mvc.perform(get("/dev-docs/public")).andExpect(status().isOk());
    mvc.perform(get("/api-docs")).andExpect(status().isNotFound());
  }
}
