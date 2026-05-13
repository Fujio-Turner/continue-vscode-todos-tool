import { createAsyncThunk } from "@reduxjs/toolkit";
import { toSessionErrorInfo } from "core/util/errorLocation";
import posthog from "posthog-js";
import StreamErrorDialog from "../../pages/gui/StreamError";
import { analyzeError } from "../../util/errorAnalysis";
import { selectSelectedChatModel } from "../slices/configSlice";
import { setDialogMessage, setShowDialog } from "../slices/uiSlice";
import { ThunkApiType } from "../store";
import { cancelStream } from "./cancelStream";
import { saveCurrentSession } from "./session";

export const streamThunkWrapper = createAsyncThunk<
  void,
  () => Promise<void>,
  ThunkApiType
>("chat/streamWrapper", async (runStream, { dispatch, getState }) => {
  try {
    await runStream();
    const state = getState();
    if (!state.session.isInEdit) {
      await dispatch(
        saveCurrentSession({
          openNewSession: false,
          generateTitle: true,
        }),
      );
    }
  } catch (e) {
    const state = getState();
    const selectedModel = selectSelectedChatModel(state);
    const { parsedError, statusCode, modelTitle, providerName } = analyzeError(
      e,
      selectedModel,
    );

    await dispatch(cancelStream());
    dispatch(setDialogMessage(<StreamErrorDialog error={e} />));
    dispatch(setShowDialog(true));

    const errorData = {
      error_type: statusCode ? `HTTP ${statusCode}` : "Unknown",
      error_message: parsedError,
      model_provider: providerName,
      model_title: modelTitle,
    };

    posthog.capture("gui_stream_error", errorData);

    // Persist the error onto the session so it lands in the local JSON file
    // and the Couchbase mirror with file/line context (or "N/A" / -1 when
    // unavailable, e.g. network/timeout errors).
    if (!state.session.isInEdit) {
      try {
        await dispatch(
          saveCurrentSession({
            openNewSession: false,
            generateTitle: false,
            error: toSessionErrorInfo(e),
          }),
        );
      } catch (saveErr) {
        console.error("Failed to save session error context", saveErr);
      }
    }
  }
});
