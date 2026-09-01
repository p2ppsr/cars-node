/*
Copyright The Helm Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// This is the upstream Helm v4.2.4 entry point, rebuilt with the fixed Go
// toolchain and patched transitive modules pinned in this directory's go.mod.
package main

import (
	"errors"
	"log/slog"
	"os"

	_ "k8s.io/client-go/plugin/pkg/client/auth"

	helmcmd "helm.sh/helm/v4/pkg/cmd"
	"helm.sh/helm/v4/pkg/kube"
)

func main() {
	kube.ManagedFieldsManager = "helm"

	command, err := helmcmd.NewRootCmd(os.Stdout, os.Args[1:], helmcmd.SetupLogging)
	if err != nil {
		slog.Warn("command failed", slog.Any("error", err))
		os.Exit(1)
	}

	if err := command.Execute(); err != nil {
		var commandError helmcmd.CommandError
		if errors.As(err, &commandError) {
			os.Exit(commandError.ExitCode)
		}
		os.Exit(1)
	}
}
