Imports System
Imports System.Collections.Generic
Imports System.Linq

Namespace Poly

    Public Enum Level
        Debug = 0
        Info = 1
        [Error] = 2
    End Enum

    Public Class Release
        Private ReadOnly _assets As List(Of String)

        Public Sub New(tag As String, Optional assets As IEnumerable(Of String) = Nothing)
            If String.IsNullOrWhiteSpace(tag) Then
                Throw New ArgumentException("tag is required", NameOf(tag))
            End If
            Me.Tag = tag
            _assets = If(assets Is Nothing, New List(Of String)(), assets.ToList())
        End Sub

        Public ReadOnly Property Tag As String

        Public ReadOnly Property AssetCount As Integer
            Get
                Return _assets.Count
            End Get
        End Property

        Public Overrides Function ToString() As String
            Return String.Format("{0} ({1} assets)", Tag, AssetCount)
        End Function
    End Class

End Namespace
